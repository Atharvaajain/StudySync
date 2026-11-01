/**
 * Timezone helpers shared by client and server (ARCHITECTURE §14.6). They use the platform's
 * Intl (ICU) data. Historical aggregation happens in SQL with each segment's own timezone
 * snapshot (D-6); these helpers only validate zones and resolve "today".
 */

/**
 * Browsers report CLDR's legacy zone ids for some places (Chrome: "Asia/Calcutta" for India).
 * PostgreSQL builds without the tz "backward" links reject those, so every boundary stores the
 * current IANA name instead. The rules of each pair are identical.
 */
const LEGACY_ZONES: Readonly<Record<string, string>> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};

/** The current IANA name for a zone id (legacy CLDR ids mapped, everything else unchanged). */
export function canonicalTimeZone(tz: string): string {
  return LEGACY_ZONES[tz] ?? tz;
}

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

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(localDate: string): number {
  const d = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** First day of the ISO week (Monday) or of the month that contains `localDate`. */
export function periodStart(localDate: string, granularity: 'week' | 'month'): string {
  return granularity === 'month'
    ? `${localDate.slice(0, 7)}-01`
    : addDays(localDate, 1 - isoWeekday(localDate));
}
