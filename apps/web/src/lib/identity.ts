/**
 * PHASE 0 ONLY — prototype identity: a display name and a random id, kept in this tab's
 * sessionStorage so a page refresh keeps the same user (and two tabs can be two users).
 * There is NO authentication in Phase 0; Phase 1 replaces this with real accounts (JWT).
 * No token is stored anywhere.
 */
import { prototypeIdentitySchema, type PrototypeIdentity } from '@studysync/shared';
import { newUuid } from './uuid';

const KEY = 'studysync.prototype.identity';

export function loadIdentity(): PrototypeIdentity | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = prototypeIdentitySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createIdentity(name: string): PrototypeIdentity {
  const identity = prototypeIdentitySchema.parse({ userId: newUuid(), name });
  try {
    sessionStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    // Storage unavailable (private mode): the identity lasts until the tab is reloaded.
  }
  return identity;
}

export function clearIdentity(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
