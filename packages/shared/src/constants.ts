/**
 * Canonical product constants (CLAUDE.md, ARCHITECTURE §20).
 * These are code, never environment configuration. Client and server import the same values.
 */

/** R4: the only legal break lengths, in minutes. 30 is the maximum. */
export const BREAK_DURATIONS_MINUTES = [5, 10, 15, 30] as const;
export type BreakMinutes = (typeof BREAK_DURATIONS_MINUTES)[number];

export function isBreakMinutes(value: unknown): value is BreakMinutes {
  return (BREAK_DURATIONS_MINUTES as readonly unknown[]).includes(value);
}

/** R9: disconnect grace (session auto-save arrives in Phase 2; display grace uses it in Phase 0). */
export const DISCONNECT_GRACE_MS = 120_000;

/** R10: idle timeout after the break countdown has finished (wired in Phase 2). */
export const BREAK_OVER_IDLE_TIMEOUT_MS = 1_800_000;

/** R11: minimum recorded study per local day for a streak day (Phase 3). */
export const STREAK_MIN_STUDY_MS = 1_500_000;

/** R17: room codes — 6 characters, no O/0/I/1. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

/** D-3: members per room. */
export const ROOM_MAX_MEMBERS = 50;

/** ARCHITECTURE §12.1: sockets per user. */
export const MAX_SOCKETS_PER_USER = 5;

/** Liveness lease and sweeper cadence (Phase 2). */
export const LEASE_REFRESH_MS = 30_000;
export const LEASE_STALE_MS = 90_000;
export const SWEEP_INTERVAL_MS = 5_000;

const MINUTE_MS = 60_000;
export function minutesToMs(minutes: number): number {
  return minutes * MINUTE_MS;
}

/** API_DESIGN §1 / ARCHITECTURE §17. */
export const CSRF_HEADER = 'X-StudySync-CSRF';
export const REFRESH_COOKIE = 'ss_refresh';
export const PERSONAL_TASK_LIMIT = 1_000;
export const HISTORY_PAGE_MAX = 100;
export const STATS_MAX_RANGE_DAYS = 366;
