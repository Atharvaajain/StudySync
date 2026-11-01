/** Drives the real SessionService directly (no sockets) to build study history quickly. */
import { randomUUID } from 'node:crypto';
import type { BreakMinutes, SessionDto } from '@studysync/shared';
import type { PresenceContext } from '../../src/modules/sessions/sessionService';
import type { Harness } from './harness';

export const SOLO: PresenceContext = { userPresenceRoomId: null, callerRoomId: null };

export async function startSolo(h: Harness, userId: string): Promise<SessionDto> {
  const r = await h.server.sessions.execute(userId, SOLO, {
    type: 'START',
    commandId: randomUUID(),
    roomId: null,
  });
  return r.session!;
}

export async function endSession(h: Harness, userId: string, sessionId: string) {
  return (
    await h.server.sessions.execute(userId, SOLO, {
      type: 'END',
      commandId: randomUUID(),
      sessionId,
    })
  ).summary!;
}

export async function breakFor(
  h: Harness,
  userId: string,
  sessionId: string,
  minutes: BreakMinutes,
): Promise<void> {
  await h.server.sessions.execute(userId, SOLO, {
    type: 'TAKE_BREAK',
    commandId: randomUUID(),
    sessionId,
    durationMinutes: minutes,
  });
  h.clock.advance(minutes * 60_000);
  await h.server.sessions.execute(userId, SOLO, {
    type: 'RESUME',
    commandId: randomUUID(),
    sessionId,
  });
}

/** One solo session of `durationMs` starting at `startIso` (moves the clock there first). */
export async function soloSession(
  h: Harness,
  userId: string,
  startIso: string,
  durationMs: number,
): Promise<string> {
  h.clock.set(Date.parse(startIso));
  const s = await startSolo(h, userId);
  h.clock.advance(durationMs);
  await endSession(h, userId, s.id);
  return s.id;
}
