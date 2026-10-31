/** Instants are epoch ms internally and ISO-8601 UTC (`…Z`) on the wire (R12). */
export const toIso = (epochMs: number): string => new Date(epochMs).toISOString();
export const toIsoOrNull = (epochMs: number | null): string | null =>
  epochMs === null ? null : toIso(epochMs);
