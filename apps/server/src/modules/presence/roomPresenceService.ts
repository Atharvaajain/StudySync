/**
 * Room presence orchestration: join, leave, socket disconnects and the 2-minute display grace
 * (I-19: someone who leaves shows their last status with "reconnecting" for up to 2 minutes,
 * then ⚫ Offline).
 *
 * Display grace is separate from session grace (§11.3): this module only decides what the
 * room shows. Whether the user's own session is live is evaluated by SessionService.
 */
import { DISCONNECT_GRACE_MS, type JoinRoomResult } from '@studysync/shared';
import type { DomainEvents } from '../../events/domainEvents';
import type { Clock } from '../../lib/clock';
import { AppError } from '../../lib/errors';
import type { KeyedQueue } from '../../lib/keyedQueue';
import type { DeadlineScheduler } from '../../lib/scheduler';
import { toIso } from '../../lib/time';
import type { RoomService } from '../rooms/roomService';
import type { SessionService } from '../sessions/sessionService';
import type { TaskService } from '../tasks/taskService';
import type { MemberStatusService } from './memberStatusService';
import type { PresenceStore } from './presenceStore';

export interface RoomPresenceDeps {
  presence: PresenceStore;
  memberStatus: MemberStatusService;
  sessions: SessionService;
  rooms: RoomService;
  tasks: TaskService;
  scheduler: DeadlineScheduler;
  events: DomainEvents;
  queue: KeyedQueue;
  clock: Clock;
}

const graceKey = (roomId: string, userId: string): string => `presence-grace:${roomId}:${userId}`;

export class RoomPresenceService {
  constructor(private readonly deps: RoomPresenceDeps) {}

  /** join_room. Throws NOT_FOUND / ROOM_FULL / SESSION_IN_OTHER_ROOM without side effects. */
  async join(
    userId: string,
    socketId: string,
    roomId: string,
  ): Promise<{ result: JoinRoomResult; previousRoomId: string | null }> {
    const { rooms, sessions, presence, memberStatus, events, clock } = this.deps;

    // Validate everything before changing anything.
    const active = sessions.activeSessionDto(userId);
    if (active?.roomId && active.roomId !== roomId) {
      throw new AppError('SESSION_IN_OTHER_ROOM', { session: active, roomName: active.roomName });
    }
    // Membership is required (NOT_FOUND otherwise, no existence leak); records the visit.
    await rooms.enter(roomId, userId);

    const wasPresent = presence.isPresent(roomId, userId);
    const wasInGrace = memberStatus.inDisplayGrace(roomId, userId);

    const previousRoomId = presence.joinRoom(socketId, roomId) ?? null;
    try {
      // A solo session moves into the room (row 11). SESSION_IN_OTHER_ROOM was rejected above.
      await sessions.enterRoom(userId, roomId);
    } catch (error) {
      presence.setSocketRoom(socketId, previousRoomId);
      throw error;
    }

    if (
      previousRoomId &&
      previousRoomId !== roomId &&
      !presence.isPresent(previousRoomId, userId)
    ) {
      this.startDisplayGrace(previousRoomId, userId);
    }

    this.deps.scheduler.cancel(graceKey(roomId, userId));
    memberStatus.clearDisplayGrace(roomId, userId);
    if (!wasPresent && !wasInGrace) events.publish({ type: 'member_joined', roomId, userId });
    else if (!wasPresent && wasInGrace)
      events.publish({ type: 'member_status_changed', roomId, userId });

    return {
      previousRoomId: previousRoomId && previousRoomId !== roomId ? previousRoomId : null,
      result: {
        room: await rooms.roomDto(roomId, userId),
        members: await memberStatus.members(roomId),
        tasks: await this.deps.tasks.listRoom(roomId),
        today: await rooms.today(roomId),
        session: sessions.activeSessionDto(userId),
        serverNow: toIso(clock.now()),
      },
    };
  }

  /** leave_room: presence ends on all of the user's sockets. Membership is unchanged (D-2). */
  async leave(userId: string, roomId: string): Promise<void> {
    await this.deps.rooms.assertMember(roomId, userId);
    const wasPresent = this.deps.presence.isPresent(roomId, userId);
    this.deps.presence.leaveRoom(userId, roomId);
    if (wasPresent) this.startDisplayGrace(roomId, userId);
  }

  /** A socket closed (tab closed, refresh, network loss). */
  socketDisconnected(socketId: string): void {
    const { userId, roomId } = this.deps.presence.removeSocket(socketId);
    if (userId && roomId && !this.deps.presence.isPresent(roomId, userId)) {
      this.startDisplayGrace(roomId, userId);
    }
  }

  private startDisplayGrace(roomId: string, userId: string): void {
    const { memberStatus, scheduler, events, queue, clock } = this.deps;
    memberStatus.startDisplayGrace(roomId, userId);
    events.publish({ type: 'member_status_changed', roomId, userId }); // reconnecting: true
    scheduler.schedule(graceKey(roomId, userId), clock.now() + DISCONNECT_GRACE_MS, () => {
      void queue.run(userId, () => this.expireDisplayGrace(roomId, userId));
    });
  }

  private expireDisplayGrace(roomId: string, userId: string): void {
    if (this.deps.presence.isPresent(roomId, userId)) return;
    if (!this.deps.memberStatus.inDisplayGrace(roomId, userId)) return;
    this.deps.memberStatus.clearDisplayGrace(roomId, userId);
    this.deps.events.publish({ type: 'member_left', roomId, userId }); // ⚫ Offline
  }
}
