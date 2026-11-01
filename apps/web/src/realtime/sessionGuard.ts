import type { SessionDto } from '@studysync/shared';

/**
 * Version guard for the caller's session (ARCHITECTURE §12.5): returns the session to hold
 * after `incoming` arrives. Older versions of the same session are dropped, and so is any late
 * push about a session this client already saw end.
 */
export function acceptSession(
  held: SessionDto | null,
  incoming: SessionDto | null,
  ended: Set<string>,
): SessionDto | null {
  if (incoming === null) {
    if (held) ended.add(held.id);
    return null;
  }
  if (ended.has(incoming.id)) return held;
  if (held && held.id === incoming.id && incoming.version < held.version) return held;
  return incoming;
}
