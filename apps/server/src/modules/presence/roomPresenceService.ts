/**
 * Room presence orchestration: join, leave, socket disconnects and the 2-minute display grace
 * (I-19: someone who leaves shows their last status with "reconnecting" for up to 2 minutes,
 * then ⚫ Offline).
 *
 * PHASE 0 scope: session auto-save after a disconnect (R9) arrives in Phase 2. In Phase 0 a
 * disconnect only affects what the room displays; it never touches anyone's timer.
 */
import { DISCONNECT_GRACE_MS, type JoinRoomResult, type RoomDto } from '@studysync/shared';
import type { DomainEvents } from '../../events/domainEvents';
import type { Clock } from '../../lib/clock';
import { AppError } from '../../lib/errors';
import type { KeyedQueue } from '../../lib/keyedQueue';
import type { DeadlineScheduler } from '../../lib/scheduler';
import { toIso } from '../../lib/time';
import type { RoomRegistry } from '../rooms/roomRegistry';
import type { SessionService } from '../sessions/sessionService';
import type { MemberStatusService } from './memberStatusService';
import type { PresenceStore } from './presenceStore';

export interface RoomPresenceDeps {
  presence: PresenceStore;
  memberStatus: MemberStatusService;
  sessions: SessionService;
  rooms: RoomRegistry;
  scheduler: DeadlineScheduler;
  events: DomainEvents;
  queue: KeyedQueue;
  clock: Clock;
}

const graceKey = (roomId: string, userId: string): string => `presence-grace:${roomId}:${userId}`;

export class RoomPresenceService {
  constructor(private readonly deps: RoomPresenceDeps) {}

  /** join_room. Throws NOT_FOUND / ROOM_FULL / SESSION_IN_OTHER_ROOM without side effects. */
  join(
    userId: string,
    socketId: string,
    roomId: string,
  ): { result: JoinRoomResult; previousRoomId: string | null } {
    const { rooms, sessions, presence, memberStatus, events, clock } = this.deps;
    const room = rooms.get(roomId);
    if (!room) throw new AppError('NOT_FOUND');

    // Validate everything before changing anything.
    const active = sessions.activeSessionDto(userId);
    if (active?.roomId && active.roomId !== roomId) {
      throw new AppError('SESSION_IN_OTHER_ROOM', { session: active, roomName: active.roomName });
    }
    // PHASE 0: entering the hardcoded room makes you a member (join-by-code is Phase 2).
    rooms.ensureMember(roomId, userId, clock.now());

    const wasPresent = presence.isPresent(roomId, userId);
    const wasInGrace = memberStatus.inDisplayGrace(roomId, userId);

    const previousRoomId = presence.joinRoom(socketId, roomId) ?? null;
    // A solo session moves into the room (row 11). Membership was ensured above, and the
    // SESSION_IN_OTHER_ROOM case was rejected before any change.
    sessions.enterRoom(userId, roomId);

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
        room: this.roomDto(roomId),
        members: memberStatus.members(roomId),
        tasks: [],
        today: null,
        session: sessions.activeSessionDto(userId),
        serverNow: toIso(clock.now()),
      },
    };
  }

  /** leave_room: presence ends on all of the user's sockets. Membership is unchanged (D-2). */
  leave(userId: string, roomId: string): void {
    if (!this.deps.rooms.get(roomId)) throw new AppError('NOT_FOUND');
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

  roomDto(roomId: string): RoomDto {
    const room = this.deps.rooms.get(roomId);
    if (!room) throw new AppError('NOT_FOUND');
    return {
      id: room.id,
      name: room.name,
      code: room.code,
      createdBy: null,
      isCreator: false,
      memberCount: this.deps.rooms.memberCount(roomId),
      createdAt: toIso(room.createdAt),
    };
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
