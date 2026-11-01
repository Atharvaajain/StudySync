/**
 * What other members see (ARCHITECTURE §11.4). A read-only view of each member's OWN
 * independent timer: there is no room timer (R1/R2).
 *
 *   present (or in display grace), session in this room: STUDYING / ON_BREAK / IDLE (break over)
 *   present, no session:                                 IDLE
 *   not present and display grace over:                  OFFLINE
 */
import type { MemberStatusDto, RoomStatus } from '@studysync/shared';
import { toIso } from '../../lib/time';
import type { UserDirectory } from '../users/userDirectory';
import type { RoomRegistry } from '../rooms/roomRegistry';
import type { SessionService } from '../sessions/sessionService';
import type { PresenceStore } from './presenceStore';

export interface MemberStatusDeps {
  presence: PresenceStore;
  sessions: SessionService;
  users: UserDirectory;
  rooms: RoomRegistry;
}

const key = (roomId: string, userId: string): string => `${roomId}:${userId}`;

export class MemberStatusService {
  private readonly versions = new Map<string, number>();
  private readonly displayGrace = new Set<string>();

  constructor(private readonly deps: MemberStatusDeps) {}

  /** Current status without bumping the version (snapshots). */
  snapshot(roomId: string, userId: string): MemberStatusDto {
    return {
      ...this.compute(roomId, userId),
      version: this.versions.get(key(roomId, userId)) ?? 0,
    };
  }

  /** Current status with a new, higher version (every push). Clients drop older versions. */
  next(roomId: string, userId: string): MemberStatusDto {
    const k = key(roomId, userId);
    const version = (this.versions.get(k) ?? 0) + 1;
    this.versions.set(k, version);
    return { ...this.compute(roomId, userId), version };
  }

  /** All members of the room, absent ones included (I-18). */
  async members(roomId: string): Promise<MemberStatusDto[]> {
    const rows = await this.deps.rooms.members(roomId);
    for (const m of rows) this.deps.users.upsert(m.userId, m.name);
    return rows.map((m) => this.snapshot(roomId, m.userId));
  }

  startDisplayGrace(roomId: string, userId: string): void {
    this.displayGrace.add(key(roomId, userId));
  }

  clearDisplayGrace(roomId: string, userId: string): void {
    this.displayGrace.delete(key(roomId, userId));
  }

  inDisplayGrace(roomId: string, userId: string): boolean {
    return this.displayGrace.has(key(roomId, userId));
  }

  private compute(roomId: string, userId: string): Omit<MemberStatusDto, 'version'> {
    const user = { id: userId, name: this.deps.users.nameOf(userId) };
    const present = this.deps.presence.isPresent(roomId, userId);
    const inGrace = this.inDisplayGrace(roomId, userId);
    if (!present && !inGrace) {
      return { user, status: 'OFFLINE', breakEndsAt: null, reconnecting: false };
    }
    const view = this.deps.sessions.roomView(userId, roomId);
    let status: RoomStatus = 'IDLE';
    if (view?.phase === 'STUDYING') status = 'STUDYING';
    else if (view?.phase === 'ON_BREAK') status = 'ON_BREAK';
    return {
      user,
      status,
      breakEndsAt: status === 'ON_BREAK' && view?.breakEndsAt ? toIso(view.breakEndsAt) : null,
      reconnecting: !present && inGrace,
    };
  }
}
