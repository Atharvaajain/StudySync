/**
 * INT-SCHEMA (TESTING_STRATEGY §5): every hand-written constraint and index from
 * DATABASE_DESIGN §5 exists after `migrate deploy`, and direct SQL that violates each one is
 * rejected. These tests deliberately bypass the services (the DB is the last line of defense).
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, resetDb, testDb } from '../helpers/db';

const db = testDb();
const T0 = new Date('2026-11-01T10:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

let userId: string;

beforeEach(async () => {
  await resetDb(db);
  userId = (await createUser(db)).id;
});

async function insertSession(
  options: {
    id?: string;
    user?: string;
    status?: 'ACTIVE' | 'ENDED';
    segmentStart?: Date | null;
    breakEnds?: Date | null;
  } = {},
): Promise<string> {
  const id = options.id ?? randomUUID();
  const status = options.status ?? 'ACTIVE';
  const ended = status === 'ENDED' ? at(600) : null;
  const reason = status === 'ENDED' ? 'USER' : null;
  const segmentStart = options.segmentStart === undefined ? T0 : options.segmentStart;
  await db.$executeRaw`
    INSERT INTO study_sessions (id, user_id, status, started_at, ended_at, end_reason,
                                current_segment_started_at, break_ends_at, last_seen_at, updated_at)
    VALUES (${id}::uuid, ${options.user ?? userId}::uuid, ${status}::"SessionStatus", ${T0},
            ${ended}, ${reason}::"SessionEndReason", ${segmentStart}, ${options.breakEnds ?? null},
            ${T0}, ${T0})`;
  return id;
}

async function insertBreak(
  sessionId: string,
  b: { minutes: number; start: Date; ends: Date; closed?: Date | null; reason?: string | null },
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO study_breaks (id, session_id, user_id, duration_minutes, started_at, ends_at,
                              closed_at, close_reason)
    VALUES (${randomUUID()}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${b.minutes}, ${b.start},
            ${b.ends}, ${b.closed ?? null}, ${b.reason ?? null}::"BreakCloseReason")`;
}

async function insertSegment(sessionId: string, start: Date, end: Date | null): Promise<void> {
  await db.$executeRaw`
    INSERT INTO study_segments (id, session_id, user_id, timezone, started_at, ended_at, end_reason)
    VALUES (${randomUUID()}::uuid, ${sessionId}::uuid, ${userId}::uuid, 'UTC', ${start}, ${end},
            ${end ? 'BREAK' : null}::"SegmentEndReason")`;
}

describe('INT-SCHEMA: named objects exist', () => {
  it('every hand-written constraint and partial index from §5 is present', async () => {
    const constraints = await db.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace`;
    const indexes = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
    const names = new Set([
      ...constraints.map((c) => c.conname),
      ...indexes.map((i) => i.indexname),
    ]);
    for (const name of [
      'users_email_lowercase',
      'users_name_not_blank',
      'rooms_code_format',
      'rooms_name_not_blank',
      'tasks_title_not_blank',
      'tasks_done_consistent',
      'tasks_version_positive',
      'tasks_personal_live',
      'tasks_room_live',
      'tasks_completed_by',
      'study_sessions_one_active_per_user',
      'study_sessions_break_deadline',
      'study_sessions_grace_deadline',
      'study_sessions_lease',
      'ss_ended_consistent',
      'ss_active_phase_xor',
      'ss_ended_clean',
      'ss_time_order',
      'ss_version_positive',
      'study_segments_one_open_per_session',
      'study_segments_one_open_per_user',
      'seg_close_consistent',
      'seg_time_order',
      'seg_no_overlap_per_user',
      'study_breaks_one_open_per_session',
      'brk_duration_allowed',
      'brk_ends_exact',
      'brk_close_consistent',
      'brk_close_window',
      'brk_resume_only_after_end',
      'brk_idle_exact',
      'brk_no_overlap_per_user',
      'evt_actor_matches_type',
      'evt_command_only_for_user',
      'evt_no_system_resume',
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it('timestamps are timestamptz and the database runs in UTC (R12)', async () => {
    const [tz] = await db.$queryRaw<
      { timezone: string }[]
    >`SELECT current_setting('TimeZone') AS timezone`;
    expect(tz!.timezone).toMatch(/^(Etc\/)?UTC$/);
    const cols = await db.$queryRaw<{ data_type: string }[]>`
      SELECT DISTINCT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name LIKE '%\\_at' ESCAPE '\\'`;
    expect(cols.map((c) => c.data_type)).toEqual(['timestamp with time zone']);
  });
});

describe('INT-SCHEMA: violations are rejected', () => {
  it('R6: a second ACTIVE session for the same user', async () => {
    await insertSession();
    // 23505 on the partial unique index study_sessions_one_active_per_user (user_id).
    await expect(insertSession()).rejects.toThrow(/23505.*Key \(user_id\)/);
  });

  it('the four-state model: an ACTIVE row is studying XOR on a break', async () => {
    await expect(insertSession({ breakEnds: at(10) })).rejects.toThrow(/ss_active_phase_xor/);
    await expect(insertSession({ segmentStart: null })).rejects.toThrow(/ss_active_phase_xor/);
  });

  it('R4: only 5/10/15/30-minute breaks, ending exactly started_at + duration', async () => {
    const s = await insertSession({ segmentStart: null, breakEnds: at(20) });
    await expect(insertBreak(s, { minutes: 20, start: T0, ends: at(20) })).rejects.toThrow(
      /brk_duration_allowed/,
    );
    await expect(insertBreak(s, { minutes: 10, start: T0, ends: at(11) })).rejects.toThrow(
      /brk_ends_exact/,
    );
  });

  it('R5: a break cannot be resumed before its countdown ends', async () => {
    const s = await insertSession({ status: 'ENDED', segmentStart: null });
    await expect(
      insertBreak(s, { minutes: 10, start: T0, ends: at(10), closed: at(9), reason: 'RESUMED' }),
    ).rejects.toThrow(/brk_resume_only_after_end/);
  });

  it('R10: a break never stays open past ends_at + 30 min; idle close is exactly +30', async () => {
    const s = await insertSession({ status: 'ENDED', segmentStart: null });
    await expect(
      insertBreak(s, {
        minutes: 5,
        start: T0,
        ends: at(5),
        closed: at(36),
        reason: 'ENDED_BY_USER',
      }),
    ).rejects.toThrow(/brk_close_window/);
    await expect(
      insertBreak(s, {
        minutes: 5,
        start: T0,
        ends: at(5),
        closed: at(34),
        reason: 'IDLE_TIMEOUT',
      }),
    ).rejects.toThrow(/brk_idle_exact/);
  });

  it('CT-7: overlapping segments or breaks of one user are rejected (GiST exclusion)', async () => {
    const s1 = await insertSession({ status: 'ENDED', segmentStart: null });
    const s2 = await insertSession({ status: 'ENDED', segmentStart: null });
    await insertSegment(s1, T0, at(30));
    await expect(insertSegment(s2, at(29), at(40))).rejects.toThrow(/seg_no_overlap_per_user/);
    await insertSegment(s2, at(30), at(40)); // half-open: touching is fine
    await insertBreak(s1, {
      minutes: 10,
      start: at(50),
      ends: at(60),
      closed: at(60),
      reason: 'RESUMED',
    });
    await expect(
      insertBreak(s2, {
        minutes: 5,
        start: at(55),
        ends: at(60),
        closed: at(60),
        reason: 'RESUMED',
      }),
    ).rejects.toThrow(/brk_no_overlap_per_user/);
  });

  it('R5: a SYSTEM event can never move a session INTO STUDYING', async () => {
    const s = await insertSession();
    await expect(db.$executeRaw`
      INSERT INTO session_events (session_id, user_id, type, actor, from_phase, to_phase, occurred_at)
      VALUES (${s}::uuid, ${userId}::uuid, 'RECONNECTED', 'SYSTEM', 'BREAK_OVER', 'STUDYING', ${T0})`).rejects.toThrow(
      /evt_no_system_resume/,
    );
    await expect(db.$executeRaw`
      INSERT INTO session_events (session_id, user_id, type, actor, from_phase, to_phase, occurred_at)
      VALUES (${s}::uuid, ${userId}::uuid, 'RESUMED', 'SYSTEM', 'BREAK_OVER', 'STUDYING', ${T0})`).rejects.toThrow(
      /evt_actor_matches_type/,
    );
  });

  it('R17: room codes are 6 characters without O, 0, I, 1', async () => {
    const insertRoom = (code: string) => db.$executeRaw`
      INSERT INTO rooms (id, name, code, created_by, updated_at)
      VALUES (${randomUUID()}::uuid, 'Room', ${code}, ${userId}::uuid, ${T0})`;
    for (const bad of ['DSA7KO', 'DSA7K0', 'DSA7KI', 'DSA7K1', 'dsa7k2', 'DSA7K']) {
      await expect(insertRoom(bad), bad).rejects.toThrow(/rooms_code_format/);
    }
    await expect(insertRoom('DSA7K22')).rejects.toThrow(); // char(6)
    await insertRoom('DSA7K2');
  });

  it('emails are stored lower-cased', async () => {
    await expect(createUser(db, { email: 'Mixed@Example.com' })).rejects.toThrow(
      /users_email_lowercase/,
    );
  });
});
