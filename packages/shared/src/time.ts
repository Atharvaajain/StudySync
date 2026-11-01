/**
 * Timezone helpers shared by client and server (ARCHITECTURE §14.6). They use the platform's
 * Intl (ICU) data. Historical aggregation happens in SQL with each segment's own timezone
 * snapshot (D-6); these helpers only validate zones and resolve "today".
 */

/** True if `tz` is an IANA timezone the runtime knows (e.g. "Asia/Kolkata", "UTC"). */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The local calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function localDateOf(epochMs: number, timeZone: string): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(epochMs);
}

/** Calendar arithmetic on YYYY-MM-DD strings (no timezone involved). */
export function addDays(localDate: string, days: number): string {
  const t = Date.parse(`${localDate}T00:00:00.000Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (YYYY-MM-DD), e.g. ("2026-11-01","2026-11-03") → 2. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
