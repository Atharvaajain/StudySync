/**
 * Rooms and membership (PHASE 0: in memory, one hardcoded room).
 * - Rooms carry NO timer state (R2).
 * - Membership is permanent: there is no removal path (D-2).
 * - At most ROOM_MAX_MEMBERS members per room (D-3).
 */
import { ROOM_MAX_MEMBERS } from '@studysync/shared';
import { AppError } from '../../lib/errors';

export interface Room {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly createdAt: number;
}

export interface Membership {
  readonly userId: string;
  readonly joinedAt: number;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly members = new Map<string, Map<string, Membership>>();

  constructor(
    rooms: readonly Room[],
    private readonly maxMembers: number = ROOM_MAX_MEMBERS,
  ) {
    for (const room of rooms) {
      this.rooms.set(room.id, room);
      this.members.set(room.id, new Map());
    }
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  isMember(roomId: string, userId: string): boolean {
    return this.members.get(roomId)?.has(userId) ?? false;
  }

  /** Idempotent. Throws ROOM_FULL when the room is at capacity (D-3). */
  ensureMember(roomId: string, userId: string, now: number): void {
    const roomMembers = this.members.get(roomId);
    if (!roomMembers) throw new AppError('NOT_FOUND');
    if (roomMembers.has(userId)) return;
    if (roomMembers.size >= this.maxMembers) throw new AppError('ROOM_FULL');
    roomMembers.set(userId, { userId, joinedAt: now });
  }

  /** All members, in join order (absent ones included; I-18). */
  membersOf(roomId: string): Membership[] {
    return [...(this.members.get(roomId)?.values() ?? [])].sort((a, b) => a.joinedAt - b.joinedAt);
  }

  memberCount(roomId: string): number {
    return this.members.get(roomId)?.size ?? 0;
  }
}
