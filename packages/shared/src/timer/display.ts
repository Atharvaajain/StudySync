/**
 * Client-side display helpers (ARCHITECTURE §16.2). They never decide anything: the server is
 * the source of truth. They only render server timestamps against a corrected clock.
 */
import type { MemberStatusDto, Phase, SessionDto } from '../dto';

/** Total study time to show: closed segments + the running segment (if studying). */
export function elapsedStudyMs(
  session: Pick<SessionDto, 'studyMsClosed' | 'currentSegmentStartedAt'>,
  nowMs: number,
): number {
  if (session.currentSegmentStartedAt === null) return session.studyMsClosed;
  const running = nowMs - Date.parse(session.currentSegmentStartedAt);
  return session.studyMsClosed + Math.max(0, running);
}

/**
 * Remaining break countdown: never negative and, when the break start is known, never longer
 * than the break itself (a client clock a few ms behind the server must not show 05:01).
 */
export function breakRemainingMs(endsAt: string, nowMs: number, startedAt?: string): number {
  const remaining = Math.max(0, Date.parse(endsAt) - nowMs);
  return startedAt === undefined
    ? remaining
    : Math.min(remaining, Date.parse(endsAt) - Date.parse(startedAt));
}

/**
 * The phase to display right now. ON_BREAK flips to BREAK_OVER locally when the countdown
 * reaches 0 (the server confirms with a push). It never flips to STUDYING: no auto resume (R5).
 */
export function displayPhase(session: Pick<SessionDto, 'phase' | 'break'>, nowMs: number): Phase {
  if (session.phase === 'ON_BREAK' && session.break && nowMs >= Date.parse(session.break.endsAt)) {
    return 'BREAK_OVER';
  }
  return session.phase;
}

/** Resume is only offered once the countdown has finished (I-05). */
export function canResume(session: Pick<SessionDto, 'phase' | 'break'>, nowMs: number): boolean {
  return displayPhase(session, nowMs) === 'BREAK_OVER';
}

/** A member shown "On Break" whose countdown has ended is displayed as Idle. */
export function displayMemberStatus(
  member: MemberStatusDto,
  nowMs: number,
): MemberStatusDto['status'] {
  if (
    member.status === 'ON_BREAK' &&
    member.breakEndsAt &&
    nowMs >= Date.parse(member.breakEndsAt)
  ) {
    return 'IDLE';
  }
  return member.status;
}

/** 0:05, 12:34, 1:02:03 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${String(m).padStart(2, '0')}:${ss}`;
}

/**
 * Countdowns round to the nearest second. (Rounding up would show "05:01" for a fresh 5-minute
 * break whenever the client clock is a few ms behind the server.) Resume is enabled by the exact
 * instant (canResume), never by this rounded text.
 */
export function formatCountdown(ms: number): string {
  return formatDuration(Math.round(Math.max(0, ms) / 1000) * 1000);
}
