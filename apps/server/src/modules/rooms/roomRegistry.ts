/**
 * Rooms and membership, stored in PostgreSQL (`rooms`, `room_members`).
 * - Rooms carry NO timer state (R2).
 * - Membership is permanent: there is no removal path (D-2).
 * - At most ROOM_MAX_MEMBERS members per room (D-3), enforced under a room row lock.
 *
 * PHASE 1 scope: room creation and join-by-code arrive in Phase 2. The only joinable room is
 * the Phase 0 prototype room ("DSA Night Study", code DSA7K2), created on first entry with the
 * first visitor as its creator. Entering it makes you a member, as in Phase 0.
 */
import { PROTOTYPE_ROOM, ROOM_MAX_MEMBERS, type RoomDto } from '@studysync/shared';
import type { Clock } from '../../lib/clock';
import { isUniqueViolation, transaction, type Db } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { toIso } from '../../lib/time';

export interface RoomMemberRow {
  userId: string;
  name: string;
  joinedAt: Date;
}

export class RoomRegistry {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly maxMembers: number = ROOM_MAX_MEMBERS,
  ) {}

  /**
   * Makes the user a member (idempotent) and records the visit. Only members can enter a room;
   * the prototype room admits anyone (Phase 0 behaviour). Throws NOT_FOUND or ROOM_FULL.
   */
  async enter(roomId: string, userId: string): Promise<void> {
    if (roomId === PROTOTYPE_ROOM.id) await this.ensurePrototypeRoom(userId);
    const now = new Date(this.clock.now());
    await transaction(this.db, async (tx) => {
      // Serialize joins per room so the member cap can't be exceeded by a race.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM rooms WHERE id = ${roomId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new AppError('NOT_FOUND');
      const existing = await tx.roomMember.findUnique({
        where: { roomId_userId: { roomId, userId } },
      });
      if (existing) {
        await tx.roomMember.update({
          where: { roomId_userId: { roomId, userId } },
          data: { lastVisitedAt: now },
        });
        return;
      }
      if (roomId !== PROTOTYPE_ROOM.id) throw new AppError('NOT_FOUND'); // membership required
      const count = await tx.roomMember.count({ where: { roomId } });
      if (count >= this.maxMembers) throw new AppError('ROOM_FULL');
      await tx.roomMember.create({ data: { roomId, userId, joinedAt: now, lastVisitedAt: now } });
    });
  }

  /** Throws NOT_FOUND unless the user is a member (no existence leak). */
  async assertMember(roomId: string, userId: string): Promise<void> {
    const member = await this.db.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { userId: true },
    });
    if (!member) throw new AppError('NOT_FOUND');
  }

  /** All members by name (absent ones included, I-18; DATABASE_DESIGN §6.5). */
  async members(roomId: string): Promise<RoomMemberRow[]> {
    const rows = await this.db.roomMember.findMany({
      where: { roomId },
      include: { user: { select: { name: true } } },
      orderBy: [{ user: { name: 'asc' } }, { userId: 'asc' }],
    });
    return rows.map((m) => ({ userId: m.userId, name: m.user.name, joinedAt: m.joinedAt }));
  }

  async roomDto(roomId: string, viewerId: string): Promise<RoomDto> {
    const room = await this.db.room.findUnique({
      where: { id: roomId },
      include: {
        createdBy: { select: { id: true, name: true } },
        _count: { select: { members: true } },
      },
    });
    if (!room) throw new AppError('NOT_FOUND');
    return {
      id: room.id,
      name: room.name,
      code: room.code,
      createdBy: room.createdBy,
      isCreator: room.createdById === viewerId,
      memberCount: room._count.members,
      createdAt: toIso(room.createdAt.getTime()),
    };
  }

  private async ensurePrototypeRoom(creatorId: string): Promise<void> {
    const exists = await this.db.room.findUnique({
      where: { id: PROTOTYPE_ROOM.id },
      select: { id: true },
    });
    if (exists) return;
    await this.db.room
      .create({
        data: {
          id: PROTOTYPE_ROOM.id,
          name: PROTOTYPE_ROOM.name,
          code: PROTOTYPE_ROOM.code,
          createdById: creatorId,
          createdAt: new Date(this.clock.now()),
        },
      })
      .catch((error: unknown) => {
        if (!isUniqueViolation(error)) throw error; // created concurrently: fine
      });
  }
}
