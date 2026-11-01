/**
 * Rooms and membership (ARCHITECTURE §11, API_DESIGN §5 Rooms), stored in PostgreSQL.
 * - Rooms are reusable and carry NO timer state (R2, R7).
 * - Membership is permanent: there is no removal path (D-2). "Leave" ends presence only.
 * - At most ROOM_MAX_MEMBERS members per room (D-3), enforced under a room row lock.
 * - Codes: 6 characters from the 32-character alphabet, `crypto.randomInt`, unique (retry on
 *   collision). The code is the access credential: every unknown or malformed code gets the
 *   same INVALID_CODE answer (E-24), and joins are rate-limited.
 */
import { randomInt } from 'node:crypto';
import {
  ROOMS_PER_USER_PER_DAY,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_MAX_MEMBERS,
  type MyRoomDto,
  type RoomDto,
  type TodayInRoomDto,
} from '@studysync/shared';
import type { Clock } from '../../lib/clock';
import { Prisma, isUniqueViolation, toDate, transaction, type Db } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { toIso } from '../../lib/time';

export interface RoomMemberRow {
  userId: string;
  name: string;
  joinedAt: Date;
}

const CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
const CODE_ATTEMPTS = 8;
const DAY_MS = 86_400_000;

export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

const roomInclude = {
  createdBy: { select: { id: true, name: true } },
  _count: { select: { members: true } },
} as const;
type RoomRow = Prisma.RoomGetPayload<{ include: typeof roomInclude }>;

function toRoomDto(room: RoomRow, viewerId: string): RoomDto {
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

export class RoomService {
  constructor(
    private readonly deps: {
      db: Db;
      clock: Clock;
      newCode?: () => string;
      maxMembers?: number;
    },
  ) {}

  private get maxMembers(): number {
    return this.deps.maxMembers ?? ROOM_MAX_MEMBERS;
  }

  /** POST /rooms: the creator becomes a member. 20 rooms per user per rolling day. */
  async create(userId: string, name: string): Promise<RoomDto> {
    const { db, clock } = this.deps;
    const now = clock.now();
    const recent = await db.room.count({
      where: { createdById: userId, createdAt: { gt: toDate(now - DAY_MS) } },
    });
    if (recent >= ROOMS_PER_USER_PER_DAY) throw new AppError('RATE_LIMITED');
    const newCode = this.deps.newCode ?? generateRoomCode;
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      try {
        const room = await transaction(db, async (tx) => {
          const created = await tx.room.create({
            data: { name, code: newCode(), createdById: userId, createdAt: toDate(now) },
          });
          await tx.roomMember.create({
            data: { roomId: created.id, userId, joinedAt: toDate(now), lastVisitedAt: toDate(now) },
          });
          return tx.room.findUniqueOrThrow({ where: { id: created.id }, include: roomInclude });
        });
        return toRoomDto(room, userId);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error; // code collision: retry with a new code
      }
    }
    throw new Error('Could not generate a unique room code');
  }

  /**
   * POST /rooms/join: membership by code (idempotent, permanent). `assertCanEnter` rejects a
   * session that lives in another room BEFORE any membership change (I-06).
   */
  async joinByCode(
    userId: string,
    rawCode: string,
    assertCanEnter: (roomId: string) => Promise<void>,
  ): Promise<RoomDto> {
    const { db, clock } = this.deps;
    const code = rawCode.trim().toUpperCase();
    if (!CODE_RE.test(code)) throw new AppError('INVALID_CODE');
    const room = await db.room.findUnique({ where: { code }, select: { id: true } });
    if (!room) throw new AppError('INVALID_CODE');
    await assertCanEnter(room.id);
    const now = toDate(clock.now());
    await transaction(db, async (tx) => {
      // Serialize joins per room so the member cap can't be exceeded by a race (CT-10).
      await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${room.id}::uuid FOR UPDATE`;
      const existing = await tx.roomMember.findUnique({
        where: { roomId_userId: { roomId: room.id, userId } },
      });
      if (existing) return;
      const count = await tx.roomMember.count({ where: { roomId: room.id } });
      if (count >= this.maxMembers) throw new AppError('ROOM_FULL');
      await tx.roomMember.create({ data: { roomId: room.id, userId, joinedAt: now } });
    });
    return this.roomDto(room.id, userId);
  }

  /** GET /rooms (§6.6): my rooms, most recently visited first. */
  async myRooms(userId: string): Promise<MyRoomDto[]> {
    const rows = await this.deps.db.roomMember.findMany({
      where: { userId },
      include: { room: { include: roomInclude } },
      orderBy: [{ lastVisitedAt: { sort: 'desc', nulls: 'last' } }, { joinedAt: 'desc' }],
    });
    return rows.map((m) => ({
      ...toRoomDto(m.room, userId),
      joinedAt: toIso(m.joinedAt.getTime()),
      lastVisitedAt: m.lastVisitedAt ? toIso(m.lastVisitedAt.getTime()) : null,
    }));
  }

  /** join_room: members only (NOT_FOUND otherwise); records the visit. */
  async enter(roomId: string, userId: string): Promise<void> {
    const updated = await this.deps.db.roomMember.updateMany({
      where: { roomId, userId },
      data: { lastVisitedAt: toDate(this.deps.clock.now()) },
    });
    if (updated.count === 0) throw new AppError('NOT_FOUND');
  }

  /** Throws NOT_FOUND unless the user is a member (no existence leak). */
  async assertMember(roomId: string, userId: string): Promise<void> {
    const member = await this.deps.db.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { userId: true },
    });
    if (!member) throw new AppError('NOT_FOUND');
  }

  /** All members by name (absent ones included, I-18; §6.5). */
  async members(roomId: string): Promise<RoomMemberRow[]> {
    const rows = await this.deps.db.roomMember.findMany({
      where: { roomId },
      include: { user: { select: { name: true } } },
      orderBy: [{ user: { name: 'asc' } }, { userId: 'asc' }],
    });
    return rows.map((m) => ({ userId: m.userId, name: m.user.name, joinedAt: m.joinedAt }));
  }

  async roomDto(roomId: string, viewerId: string): Promise<RoomDto> {
    const room = await this.deps.db.room.findUnique({
      where: { id: roomId },
      include: roomInclude,
    });
    if (!room) throw new AppError('NOT_FOUND');
    return toRoomDto(room, viewerId);
  }

  /**
   * Today in this room (§6.3, I-09): for every member, the study done IN THIS ROOM during the
   * member's own local today (their own timezone), running segments included. Members with
   * nothing today and not studying are left out.
   */
  async today(roomId: string): Promise<TodayInRoomDto> {
    const nowMs = this.deps.clock.now();
    const now = toDate(nowMs);
    const rows = await this.deps.db.$queryRaw<
      { user_id: string; name: string; today_ms: bigint; studying_since: Date | null }[]
    >`
      WITH members AS (
        SELECT u.id AS user_id, u.name, (${now}::timestamptz AT TIME ZONE u.timezone)::date AS today
        FROM room_members m JOIN users u ON u.id = m.user_id
        WHERE m.room_id = ${roomId}::uuid
      ),
      seg AS (
        SELECT s.user_id, s.timezone AS tz, s.started_at, COALESCE(s.ended_at, ${now}::timestamptz) AS ended_at
        FROM study_segments s JOIN members mb ON mb.user_id = s.user_id
        WHERE s.room_id = ${roomId}::uuid
          AND COALESCE(s.ended_at, ${now}::timestamptz) > ${now}::timestamptz - interval '2 days'
      ),
      pieces AS (
        SELECT seg.user_id, d.local_day::date AS local_date,
               GREATEST(seg.started_at, d.local_day AT TIME ZONE seg.tz)                 AS p_start,
               LEAST(seg.ended_at, (d.local_day + interval '1 day') AT TIME ZONE seg.tz) AS p_end
        FROM seg CROSS JOIN LATERAL generate_series(
            date_trunc('day', seg.started_at AT TIME ZONE seg.tz),
            date_trunc('day', seg.ended_at   AT TIME ZONE seg.tz), interval '1 day') AS d(local_day)
      )
      SELECT mb.user_id, mb.name,
             COALESCE(SUM(EXTRACT(EPOCH FROM p.p_end - p.p_start) * 1000)
                      FILTER (WHERE p.local_date = mb.today AND p.p_end > p.p_start), 0)::bigint AS today_ms,
             ss.current_segment_started_at AS studying_since
      FROM members mb
      LEFT JOIN pieces p ON p.user_id = mb.user_id
      LEFT JOIN study_sessions ss ON ss.user_id = mb.user_id AND ss.status = 'ACTIVE' AND ss.room_id = ${roomId}::uuid
      GROUP BY mb.user_id, mb.name, ss.current_segment_started_at
      ORDER BY today_ms DESC, mb.name`;
    return {
      roomId,
      serverNow: toIso(nowMs),
      members: rows
        .filter((r) => Number(r.today_ms) > 0 || r.studying_since !== null)
        .map((r) => ({
          user: { id: r.user_id, name: r.name },
          todayMs: Number(r.today_ms),
          studyingSince: r.studying_since ? toIso(r.studying_since.getTime()) : null,
        })),
    };
  }
}
