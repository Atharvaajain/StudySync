/**
 * Invariant audit queries (DATABASE_DESIGN §8). Any returned row is a bug. Run after every
 * DB-backed test, and nightly against production (`npm run db:audit`).
 */
import type { Db } from './db';

type Row = { id: unknown }[];

const AUDITS: Record<string, (db: Db) => Promise<Row>> = {
  'A segment overlaps break': (db) => db.$queryRaw<Row>`
    SELECT g.id FROM study_segments g JOIN study_breaks b ON b.user_id = g.user_id
     AND tstzrange(g.started_at, g.ended_at, '[)') && tstzrange(b.started_at, b.closed_at, '[)')`,
  'B studying ⇔ one open segment': (db) => db.$queryRaw<Row>`
    SELECT ss.id FROM study_sessions ss
    LEFT JOIN study_segments g ON g.session_id = ss.id AND g.ended_at IS NULL
    WHERE ss.status = 'ACTIVE'
      AND ((ss.current_segment_started_at IS NULL) <> (g.id IS NULL)
           OR g.started_at IS DISTINCT FROM ss.current_segment_started_at)`,
  'C on break ⇔ one open break': (db) => db.$queryRaw<Row>`
    SELECT ss.id FROM study_sessions ss
    LEFT JOIN study_breaks b ON b.session_id = ss.id AND b.closed_at IS NULL
    WHERE ss.status = 'ACTIVE'
      AND ((ss.break_ends_at IS NULL) <> (b.id IS NULL) OR b.ends_at IS DISTINCT FROM ss.break_ends_at)`,
  'D ended sessions clean': (db) => db.$queryRaw<Row>`
    SELECT ss.id FROM study_sessions ss
    WHERE ss.status = 'ENDED' AND (
          EXISTS (SELECT 1 FROM study_segments g WHERE g.session_id = ss.id AND (g.ended_at IS NULL OR g.ended_at > ss.ended_at OR g.started_at < ss.started_at))
       OR EXISTS (SELECT 1 FROM study_breaks  b WHERE b.session_id = ss.id AND (b.closed_at IS NULL OR b.closed_at > ss.ended_at OR b.started_at < ss.started_at)))`,
  'E only users enter STUDYING': (db) => db.$queryRaw<Row>`
    SELECT id FROM session_events
    WHERE to_phase = 'STUDYING' AND from_phase <> 'STUDYING' AND actor <> 'USER'`,
  'F resume continues at the same instant': (db) => db.$queryRaw<Row>`
    SELECT b.id FROM study_breaks b
    WHERE b.close_reason = 'RESUMED'
      AND NOT EXISTS (SELECT 1 FROM study_segments g WHERE g.session_id = b.session_id AND g.started_at = b.closed_at)`,
  'G room session user is a member': (db) => db.$queryRaw<Row>`
    SELECT ss.id FROM study_sessions ss
    WHERE ss.room_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = ss.room_id AND m.user_id = ss.user_id)`,
  'H rooms have no timer columns': (db) => db.$queryRaw<Row>`
    SELECT column_name AS id FROM information_schema.columns
    WHERE table_name = 'rooms' AND column_name ~ '(timer|break|segment|started|ends_at|duration)'`,
};

/** DATABASE_DESIGN §8: any returned row is a bug. Returns human-readable violations. */
/** Runs every audit; returns human-readable violations (empty = consistent). */
export async function runAudit(db: Db): Promise<string[]> {
  const violations: string[] = [];
  for (const [name, query] of Object.entries(AUDITS)) {
    for (const row of await query(db)) violations.push(`${name}: ${String(row.id)}`);
  }
  return violations;
}
