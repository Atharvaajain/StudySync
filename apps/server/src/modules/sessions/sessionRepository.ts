/**
 * Session persistence (DATABASE_DESIGN §4–§6). Maps the pure machine's effects onto the four
 * timer tables inside one transaction. The hand-written constraints (§5) are the last line of
 * defense: any disagreement between the machine and the rows aborts the whole transaction.
 */
import {
  isBreakMinutes,
  type Effect,
  type SessionCore,
  type SessionHistoryItem,
  type SessionSummaryDto,
  type TimerEvent,
  type TimerEventType,
} from '@studysync/shared';
import { Prisma, msOf, msOrNull, toDate, toDateOrNull, type Db, type Tx } from '../../lib/db';
import { IntegrityError } from '../../lib/errors';
import { toIso, toIsoOrNull } from '../../lib/time';

/** The caller's ACTIVE session plus what its DTO needs. */
export interface SessionView {
  core: SessionCore;
  studyMsClosed: number;
  roomName: string | null;
  task: { id: string; title: string } | null;
}

/** Loads the user's ACTIVE session. With `forUpdate`, the row is locked (§13.8). */
export async function loadActiveView(
  db: Db | Tx,
  userId: string,
  options: { forUpdate: boolean },
): Promise<SessionView | null> {
  if (options.forUpdate) {
    await db.$queryRaw`
      SELECT id FROM study_sessions WHERE user_id = ${userId}::uuid AND status = 'ACTIVE' FOR UPDATE`;
  }
  const s = await db.studySession.findFirst({
    where: { userId, status: 'ACTIVE' },
    include: {
      breaks: { where: { closedAt: null } },
      segments: { where: { endedAt: { not: null } }, select: { startedAt: true, endedAt: true } },
      room: { select: { name: true } },
      task: { select: { id: true, title: true } },
    },
  });
  if (!s) return null;
  const open = s.breaks[0] ?? null;
  if (open && !isBreakMinutes(open.durationMinutes)) {
    throw new IntegrityError('brk_duration_allowed', `break of ${open.durationMinutes} min`);
  }
  return {
    core: {
      id: s.id,
      roomId: s.roomId,
      taskId: s.taskId,
      startedAt: msOf(s.startedAt),
      currentSegmentStartedAt: msOrNull(s.currentSegmentStartedAt),
      currentBreak:
        open && isBreakMinutes(open.durationMinutes)
          ? {
              durationMinutes: open.durationMinutes,
              startedAt: msOf(open.startedAt),
              endsAt: msOf(open.endsAt),
            }
          : null,
      version: s.version,
    },
    studyMsClosed: s.segments.reduce((sum, g) => sum + (msOf(g.endedAt!) - msOf(g.startedAt)), 0),
    roomName: s.room?.name ?? null,
    task: s.task,
  };
}

/** C3: the stored outcome of an already-applied commandId. */
export async function findCommand(
  tx: Tx,
  userId: string,
  commandId: string,
): Promise<{ type: string; sessionId: string } | null> {
  return tx.sessionEvent.findUnique({
    where: { userId_commandId: { userId, commandId } },
    select: { type: true, sessionId: true },
  });
}

export interface TransitionWrite {
  userId: string;
  /** The session before the transition (null for START). */
  core: SessionCore | null;
  /** The session after the transition (null when it ended). */
  next: SessionCore | null;
  effects: readonly Effect[];
  event: TimerEvent;
  commandId: string | null;
}

/** Applies one machine decision to the rows. Must run inside the user's locked transaction. */
export async function applyTransition(tx: Tx, t: TransitionWrite): Promise<string> {
  const { userId, core, next, effects, event } = t;
  const sessionId = next?.id ?? core?.id;
  if (!sessionId) throw new IntegrityError('session_exists', 'transition without a session');

  // D-6: every new segment snapshots the user's timezone at the instant it starts.
  let timezone: string | null = null;
  if (effects.some((e) => e.type === 'OPEN_SEGMENT')) {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true },
    });
    timezone = user.timezone;
  }

  const create = effects.find((e) => e.type === 'CREATE_SESSION');
  if (create) {
    if (!next || core)
      throw new IntegrityError('session_pk', 'CREATE_SESSION needs no prior session');
    // One INSERT carries the final phase columns (ss_active_phase_xor is checked per row).
    await tx.studySession.create({
      data: {
        id: next.id,
        userId,
        roomId: create.roomId,
        taskId: create.taskId,
        status: 'ACTIVE',
        startedAt: toDate(create.at),
        currentSegmentStartedAt: toDateOrNull(next.currentSegmentStartedAt),
        breakEndsAt: toDateOrNull(next.currentBreak?.endsAt ?? null),
        lastSeenAt: toDate(create.at),
        version: next.version,
      },
    });
  }

  for (const effect of effects) {
    switch (effect.type) {
      case 'OPEN_SEGMENT':
        await tx.studySegment.create({
          data: {
            sessionId,
            userId,
            roomId: effect.roomId,
            timezone: timezone!,
            startedAt: toDate(effect.at),
          },
        });
        break;
      case 'CLOSE_SEGMENT': {
        const closed = await tx.studySegment.updateMany({
          where: { sessionId, endedAt: null },
          data: { endedAt: toDate(effect.at), endReason: effect.reason },
        });
        if (closed.count !== 1) throw new IntegrityError('seg_close', 'no open segment to close');
        break;
      }
      case 'OPEN_BREAK':
        await tx.studyBreak.create({
          data: {
            sessionId,
            userId,
            durationMinutes: effect.durationMinutes,
            startedAt: toDate(effect.at),
            endsAt: toDate(effect.endsAt),
          },
        });
        break;
      case 'CLOSE_BREAK': {
        const closed = await tx.studyBreak.updateMany({
          where: { sessionId, closedAt: null },
          data: { closedAt: toDate(effect.at), closeReason: effect.reason },
        });
        if (closed.count !== 1) throw new IntegrityError('brk_close', 'no open break to close');
        break;
      }
      case 'CREATE_SESSION':
      case 'SET_ROOM':
      case 'SET_TASK':
      case 'END_SESSION':
        break; // session-row columns, written once below
    }
  }

  if (!create) {
    if (!core) throw new IntegrityError('session_exists', 'transition needs an existing session');
    const end = effects.find((e) => e.type === 'END_SESSION');
    const data: Prisma.StudySessionUncheckedUpdateManyInput = next
      ? {
          roomId: next.roomId,
          taskId: next.taskId,
          currentSegmentStartedAt: toDateOrNull(next.currentSegmentStartedAt),
          breakEndsAt: toDateOrNull(next.currentBreak?.endsAt ?? null),
          version: next.version,
        }
      : end
        ? {
            status: 'ENDED',
            endedAt: toDate(end.at),
            endReason: end.reason,
            currentSegmentStartedAt: null,
            breakEndsAt: null,
            disconnectedAt: null,
            version: core.version + 1,
          }
        : (() => {
            throw new IntegrityError('machine_store_agreement', 'session should have ended');
          })();
    const updated = await tx.studySession.updateMany({
      where: { id: sessionId, userId, status: 'ACTIVE', version: core.version },
      data,
    });
    if (updated.count !== 1) {
      throw new IntegrityError('ss_version', 'the session changed concurrently');
    }
  }

  await tx.sessionEvent.create({
    data: {
      sessionId,
      userId,
      type: event.type,
      actor: event.actor,
      fromPhase: event.fromPhase,
      toPhase: event.toPhase,
      occurredAt: toDate(event.at),
      commandId: t.commandId,
    },
  });
  return sessionId;
}

/**
 * I-17: attachable = your own non-deleted personal task, or a non-deleted task of the
 * session's room.
 */
export async function isTaskAttachable(
  db: Db | Tx,
  userId: string,
  taskId: string,
  sessionRoomId: string | null,
): Promise<boolean> {
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { userId: true, roomId: true, deletedAt: true },
  });
  if (!task || task.deletedAt !== null) return false;
  if (task.roomId === null) return task.userId === userId;
  return sessionRoomId !== null && task.roomId === sessionRoomId;
}

const EVENT_TYPES: ReadonlySet<string> = new Set<TimerEventType>([
  'STARTED',
  'BREAK_TAKEN',
  'RESUMED',
  'ENDED',
  'MOVED_TO_ROOM',
  'TASK_SET',
]);
export const isUserEventType = (type: string): type is TimerEventType => EVENT_TYPES.has(type);

// ───────────── reads (DATABASE_DESIGN §6.4, §6.10) ─────────────

interface SummaryRow {
  id: string;
  room_id: string | null;
  started_at: Date;
  ended_at: Date | null;
  end_reason: 'USER' | 'DISCONNECTED' | 'IDLE_TIMEOUT' | null;
  room_name: string | null;
  task_id: string | null;
  task_title: string | null;
  studied_ms: bigint;
  break_count: number;
  break_ms: bigint;
  had_solo_part: boolean;
}

/** §6.4. Owner only: another user's session id returns null (→ 404, no existence leak). */
export async function sessionSummary(
  db: Db | Tx,
  userId: string,
  sessionId: string,
  now: number,
): Promise<SessionSummaryDto | null> {
  const at = toDate(now);
  const rows = await db.$queryRaw<SummaryRow[]>`
    SELECT ss.id, ss.room_id, ss.started_at, ss.ended_at, ss.end_reason::text AS end_reason,
           r.name AS room_name, t.id AS task_id, t.title AS task_title,
           (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM COALESCE(g.ended_at, ${at}::timestamptz) - g.started_at) * 1000), 0)::bigint
              FROM study_segments g WHERE g.session_id = ss.id)                                   AS studied_ms,
           (SELECT COUNT(*)::int FROM study_breaks b WHERE b.session_id = ss.id)                   AS break_count,
           (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM LEAST(COALESCE(b.closed_at, ${at}::timestamptz), b.ends_at) - b.started_at) * 1000), 0)::bigint
              FROM study_breaks b WHERE b.session_id = ss.id)                                     AS break_ms,
           EXISTS (SELECT 1 FROM study_segments g WHERE g.session_id = ss.id AND g.room_id IS NULL) AS had_solo_part
    FROM study_sessions ss
    LEFT JOIN rooms r ON r.id = ss.room_id
    LEFT JOIN tasks t ON t.id = ss.task_id
    WHERE ss.id = ${sessionId}::uuid AND ss.user_id = ${userId}::uuid`;
  const row = rows[0];
  if (!row) return null;

  // I-13: tasks this user marked done during the session (personal or room).
  const completed = await db.$queryRaw<{ id: string; title: string }[]>`
    SELECT id, title FROM tasks
    WHERE completed_by_id = ${userId}::uuid AND status = 'DONE'
      AND completed_at >= ${row.started_at}::timestamptz
      AND completed_at <= COALESCE(${row.ended_at}::timestamptz, ${at}::timestamptz)
    ORDER BY completed_at`;

  return {
    id: row.id,
    startedAt: toIso(msOf(row.started_at)),
    endedAt: toIsoOrNull(msOrNull(row.ended_at)),
    endReason: row.end_reason,
    studiedMs: Number(row.studied_ms),
    breaks: { count: row.break_count, totalMs: Number(row.break_ms) },
    where: {
      roomId: row.room_id,
      roomName: row.room_name,
      movedFromSolo: row.room_id !== null && row.had_solo_part,
    },
    task: row.task_id && row.task_title ? { id: row.task_id, title: row.task_title } : null,
    completedTasks: completed,
  };
}

interface HistoryRow {
  id: string;
  room_id: string | null;
  room_name: string | null;
  started_at: Date;
  ended_at: Date | null;
  end_reason: 'USER' | 'DISCONNECTED' | 'IDLE_TIMEOUT' | null;
  studied_ms: bigint;
}

/** §6.10: newest first, keyset pagination on (started_at, id). */
export async function sessionHistory(
  db: Db,
  userId: string,
  after: { startedAt: Date; id: string } | null,
  limit: number,
  now: number,
): Promise<SessionHistoryItem[]> {
  const at = toDate(now);
  const cursor = after
    ? Prisma.sql`AND (ss.started_at, ss.id) < (${after.startedAt}::timestamptz, ${after.id}::uuid)`
    : Prisma.empty;
  const rows = await db.$queryRaw<HistoryRow[]>`
    SELECT ss.id, ss.room_id, r.name AS room_name, ss.started_at, ss.ended_at,
           ss.end_reason::text AS end_reason,
           (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM COALESCE(g.ended_at, ${at}::timestamptz) - g.started_at) * 1000), 0)::bigint
              FROM study_segments g WHERE g.session_id = ss.id) AS studied_ms
    FROM study_sessions ss LEFT JOIN rooms r ON r.id = ss.room_id
    WHERE ss.user_id = ${userId}::uuid ${cursor}
    ORDER BY ss.started_at DESC, ss.id DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    startedAt: toIso(msOf(r.started_at)),
    endedAt: toIsoOrNull(msOrNull(r.ended_at)),
    endReason: r.end_reason,
    roomId: r.room_id,
    roomName: r.room_name,
    studiedMs: Number(r.studied_ms),
  }));
}
