/**
 * PHASE 0 in-memory session store. It mirrors the approved tables (`study_sessions`,
 * `study_segments`, `study_breaks`, `session_events`; DATABASE_DESIGN §4) and enforces the
 * same integrity rules as the hand-written constraints (§5), under the same names. Every
 * transition is validated as a whole and then committed atomically: it is all or nothing.
 * Phase 1 replaces this module with a Prisma repository behind the same interface.
 */
import {
  BREAK_OVER_IDLE_TIMEOUT_MS,
  isBreakMinutes,
  minutesToMs,
  type BreakCloseReason,
  type BreakMinutes,
  type Effect,
  type PhaseOrNone,
  type SegmentEndReason,
  type SessionCore,
  type TimerEvent,
  type TimerEventType,
} from '@studysync/shared';
import { IntegrityError } from '../../lib/errors';

export interface SessionRow {
  id: string;
  userId: string;
  roomId: string | null;
  status: 'ACTIVE' | 'ENDED';
  startedAt: number;
  endedAt: number | null;
  endReason: 'USER' | null;
  currentSegmentStartedAt: number | null;
  breakEndsAt: number | null;
  version: number;
}

export interface SegmentRow {
  id: string;
  sessionId: string;
  userId: string;
  roomId: string | null;
  startedAt: number;
  endedAt: number | null;
  endReason: SegmentEndReason | null;
}

export interface BreakRow {
  id: string;
  sessionId: string;
  userId: string;
  durationMinutes: BreakMinutes;
  startedAt: number;
  endsAt: number;
  closedAt: number | null;
  closeReason: BreakCloseReason | null;
}

export interface EventRow {
  id: number;
  sessionId: string;
  userId: string;
  type: TimerEventType;
  actor: 'USER' | 'SYSTEM';
  fromPhase: PhaseOrNone;
  toPhase: PhaseOrNone | 'ENDED';
  occurredAt: number;
  commandId: string | null;
}

export interface Transition {
  userId: string;
  sessionId: string;
  /** The session after the transition, or null if it ended. */
  next: SessionCore | null;
  effects: readonly Effect[];
  event: TimerEvent;
  commandId: string | null;
}

const USER_EVENT_TYPES: ReadonlySet<TimerEventType> = new Set([
  'STARTED',
  'BREAK_TAKEN',
  'RESUMED',
  'ENDED',
  'MOVED_TO_ROOM',
]);

const overlaps = (aStart: number, aEnd: number | null, bStart: number, bEnd: number | null) =>
  // Half-open intervals [start, end); an open interval (end = null) is unbounded.
  aStart < (bEnd ?? Infinity) && bStart < (aEnd ?? Infinity);

export class InMemorySessionStore {
  private readonly sessions = new Map<string, SessionRow>();
  private readonly activeByUser = new Map<string, string>();
  private segments: SegmentRow[] = [];
  private breaks: BreakRow[] = [];
  private readonly events: EventRow[] = [];
  private readonly commands = new Map<string, EventRow>();
  private nextEventId = 1;

  constructor(private readonly newId: () => string) {}

  // ───────────── reads ─────────────

  getSession(id: string): SessionRow | undefined {
    const row = this.sessions.get(id);
    return row ? { ...row } : undefined;
  }

  activeSessionRow(userId: string): SessionRow | undefined {
    const id = this.activeByUser.get(userId);
    return id ? this.getSession(id) : undefined;
  }

  /** The pure-machine view of the user's ACTIVE session (or null). */
  activeCore(userId: string): SessionCore | null {
    const row = this.activeSessionRow(userId);
    if (!row) return null;
    const open = this.openBreakOf(row.id);
    return {
      id: row.id,
      roomId: row.roomId,
      startedAt: row.startedAt,
      currentSegmentStartedAt: row.currentSegmentStartedAt,
      currentBreak: open
        ? { durationMinutes: open.durationMinutes, startedAt: open.startedAt, endsAt: open.endsAt }
        : null,
      version: row.version,
    };
  }

  segmentsOf(sessionId: string): SegmentRow[] {
    return this.segments.filter((s) => s.sessionId === sessionId).map((s) => ({ ...s }));
  }

  breaksOf(sessionId: string): BreakRow[] {
    return this.breaks.filter((b) => b.sessionId === sessionId).map((b) => ({ ...b }));
  }

  openBreakOf(sessionId: string): BreakRow | undefined {
    const b = this.breaks.find((x) => x.sessionId === sessionId && x.closedAt === null);
    return b ? { ...b } : undefined;
  }

  eventsOf(sessionId: string): EventRow[] {
    return this.events.filter((e) => e.sessionId === sessionId).map((e) => ({ ...e }));
  }

  findCommand(userId: string, commandId: string): EventRow | undefined {
    const e = this.commands.get(`${userId}:${commandId}`);
    return e ? { ...e } : undefined;
  }

  allSessions(): SessionRow[] {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }

  // ───────────── writes ─────────────

  /** Validate and commit one transition atomically (all or nothing). */
  apply(t: Transition): void {
    const existing = this.sessions.get(t.sessionId);
    let session: SessionRow | null = existing ? { ...existing } : null;
    const segments = this.segments.map((s) => ({ ...s }));
    const breaks = this.breaks.map((b) => ({ ...b }));

    if (session && session.userId !== t.userId) {
      throw new IntegrityError('session_owner', 'session belongs to another user');
    }
    if (session && session.status !== 'ACTIVE') {
      throw new IntegrityError('ss_ended_terminal', 'an ENDED session cannot change');
    }

    for (const effect of t.effects) {
      switch (effect.type) {
        case 'CREATE_SESSION': {
          if (session) throw new IntegrityError('session_pk', 'session already exists');
          session = {
            id: t.sessionId,
            userId: t.userId,
            roomId: effect.roomId,
            status: 'ACTIVE',
            startedAt: effect.at,
            endedAt: null,
            endReason: null,
            currentSegmentStartedAt: null,
            breakEndsAt: null,
            version: 0,
          };
          break;
        }
        case 'OPEN_SEGMENT': {
          const s = this.requireSession(session);
          segments.push({
            id: this.newId(),
            sessionId: s.id,
            userId: t.userId,
            roomId: effect.roomId,
            startedAt: effect.at,
            endedAt: null,
            endReason: null,
          });
          s.currentSegmentStartedAt = effect.at;
          break;
        }
        case 'CLOSE_SEGMENT': {
          const s = this.requireSession(session);
          const open = segments.find((g) => g.sessionId === s.id && g.endedAt === null);
          if (!open) throw new IntegrityError('seg_close', 'no open segment to close');
          open.endedAt = effect.at;
          open.endReason = effect.reason;
          s.currentSegmentStartedAt = null;
          break;
        }
        case 'OPEN_BREAK': {
          const s = this.requireSession(session);
          breaks.push({
            id: this.newId(),
            sessionId: s.id,
            userId: t.userId,
            durationMinutes: effect.durationMinutes,
            startedAt: effect.at,
            endsAt: effect.endsAt,
            closedAt: null,
            closeReason: null,
          });
          s.breakEndsAt = effect.endsAt;
          break;
        }
        case 'CLOSE_BREAK': {
          const s = this.requireSession(session);
          const open = breaks.find((b) => b.sessionId === s.id && b.closedAt === null);
          if (!open) throw new IntegrityError('brk_close', 'no open break to close');
          open.closedAt = effect.at;
          open.closeReason = effect.reason;
          s.breakEndsAt = null;
          break;
        }
        case 'SET_ROOM': {
          this.requireSession(session).roomId = effect.roomId;
          break;
        }
        case 'END_SESSION': {
          const s = this.requireSession(session);
          s.status = 'ENDED';
          s.endedAt = effect.at;
          s.endReason = effect.reason;
          break;
        }
      }
    }

    const s = this.requireSession(session);
    const previousVersion = existing?.version ?? 0;
    s.version = t.next ? t.next.version : previousVersion + 1;

    // The machine's view and the stored rows must agree exactly.
    if (t.next) {
      const expectedBreakEnd = t.next.currentBreak?.endsAt ?? null;
      if (
        s.status !== 'ACTIVE' ||
        s.currentSegmentStartedAt !== t.next.currentSegmentStartedAt ||
        s.breakEndsAt !== expectedBreakEnd ||
        s.roomId !== t.next.roomId
      ) {
        throw new IntegrityError('machine_store_agreement', 'effects disagree with next state');
      }
    } else if (s.status !== 'ENDED') {
      throw new IntegrityError('machine_store_agreement', 'session should have ended');
    }

    const event: EventRow = {
      id: this.nextEventId,
      sessionId: s.id,
      userId: t.userId,
      type: t.event.type,
      actor: t.event.actor,
      fromPhase: t.event.fromPhase,
      toPhase: t.event.toPhase,
      occurredAt: t.event.at,
      commandId: t.commandId,
    };

    this.validate(t.userId, s, segments, breaks, event, previousVersion);

    // ── commit ──
    this.sessions.set(s.id, s);
    if (s.status === 'ACTIVE') this.activeByUser.set(t.userId, s.id);
    else if (this.activeByUser.get(t.userId) === s.id) this.activeByUser.delete(t.userId);
    this.segments = segments;
    this.breaks = breaks;
    this.events.push(event);
    this.nextEventId += 1;
    if (event.commandId) this.commands.set(`${t.userId}:${event.commandId}`, event);
  }

  /**
   * Whole-store invariant audit: the in-memory equivalent of DATABASE_DESIGN §8 (A–F).
   * Returns human-readable violations; an empty array means the data is consistent.
   */
  audit(): string[] {
    const violations: string[] = [];
    const users = new Set([...this.sessions.values()].map((s) => s.userId));
    for (const userId of users) {
      const active = [...this.sessions.values()].filter(
        (s) => s.userId === userId && s.status === 'ACTIVE',
      );
      if (active.length > 1) violations.push(`user ${userId}: ${active.length} ACTIVE sessions`);
    }
    for (const s of this.sessions.values()) {
      const segs = this.segments.filter((g) => g.sessionId === s.id);
      const brks = this.breaks.filter((b) => b.sessionId === s.id);
      const evts = this.events.filter((e) => e.sessionId === s.id);
      try {
        this.validateSessionRow(s);
        this.validateIntervals(s.userId, this.segments, this.breaks);
      } catch (e) {
        violations.push(`session ${s.id}: ${(e as Error).message}`);
      }
      const open = segs.filter((g) => g.endedAt === null);
      if (s.status === 'ACTIVE') {
        // B: studying ⇔ exactly one open segment matching current_segment_started_at
        if ((s.currentSegmentStartedAt === null) !== (open.length === 0) || open.length > 1)
          violations.push(`session ${s.id}: audit B (open segment mismatch)`);
        if (open[0] && open[0].startedAt !== s.currentSegmentStartedAt)
          violations.push(`session ${s.id}: audit B (segment start mismatch)`);
        // C: on a break ⇔ exactly one open break matching break_ends_at
        const openB = brks.filter((b) => b.closedAt === null);
        if ((s.breakEndsAt === null) !== (openB.length === 0) || openB.length > 1)
          violations.push(`session ${s.id}: audit C (open break mismatch)`);
        if (openB[0] && openB[0].endsAt !== s.breakEndsAt)
          violations.push(`session ${s.id}: audit C (break end mismatch)`);
      } else {
        // D: ended sessions have nothing open; intervals lie inside the session window
        if (open.length > 0 || brks.some((b) => b.closedAt === null))
          violations.push(`session ${s.id}: audit D (open interval on ENDED session)`);
        const end = s.endedAt ?? Infinity;
        if (segs.some((g) => g.startedAt < s.startedAt || (g.endedAt ?? Infinity) > end))
          violations.push(`session ${s.id}: audit D (segment outside session window)`);
        if (brks.some((b) => b.startedAt < s.startedAt || (b.closedAt ?? Infinity) > end))
          violations.push(`session ${s.id}: audit D (break outside session window)`);
      }
      // E: every entry into STUDYING was user-initiated
      if (
        evts.some(
          (e) => e.toPhase === 'STUDYING' && e.fromPhase !== 'STUDYING' && e.actor !== 'USER',
        )
      )
        violations.push(`session ${s.id}: audit E (system entered STUDYING)`);
      // F: every resumed break is followed by a segment starting at the same instant
      for (const b of brks.filter((x) => x.closeReason === 'RESUMED')) {
        if (!segs.some((g) => g.startedAt === b.closedAt))
          violations.push(`session ${s.id}: audit F (resume without a segment at ${b.closedAt})`);
      }
    }
    return violations;
  }

  // ───────────── constraint checks (DATABASE_DESIGN §5 names) ─────────────

  private validate(
    userId: string,
    s: SessionRow,
    segments: SegmentRow[],
    breaks: BreakRow[],
    event: EventRow,
    previousVersion: number,
  ): void {
    // study_sessions_one_active_per_user (R6)
    const otherActive = this.activeByUser.get(userId);
    if (s.status === 'ACTIVE' && otherActive !== undefined && otherActive !== s.id) {
      throw new IntegrityError(
        'study_sessions_one_active_per_user',
        'user already has an ACTIVE session',
      );
    }
    if (s.version <= previousVersion) {
      throw new IntegrityError('ss_version_increasing', 'version must strictly increase');
    }
    this.validateSessionRow(s);
    this.validateIntervals(userId, segments, breaks);

    // session_events: evt_actor_matches_type, evt_no_system_resume, (user_id, command_id) unique
    if (USER_EVENT_TYPES.has(event.type) !== (event.actor === 'USER')) {
      throw new IntegrityError('evt_actor_matches_type', 'event type and actor disagree');
    }
    if (event.actor !== 'USER' && event.toPhase === 'STUDYING' && event.fromPhase !== 'STUDYING') {
      throw new IntegrityError('evt_no_system_resume', 'only users can enter STUDYING');
    }
    if (event.commandId && this.commands.has(`${userId}:${event.commandId}`)) {
      throw new IntegrityError('session_events_user_id_command_id_key', 'duplicate commandId');
    }
  }

  private validateSessionRow(s: SessionRow): void {
    if (
      (s.status === 'ENDED') !== (s.endedAt !== null) ||
      (s.status === 'ENDED') !== (s.endReason !== null)
    ) {
      throw new IntegrityError('ss_ended_consistent', 'ENDED ⇔ ended_at ⇔ end_reason');
    }
    if (
      s.status === 'ACTIVE' &&
      (s.currentSegmentStartedAt === null) === (s.breakEndsAt === null)
    ) {
      throw new IntegrityError(
        'ss_active_phase_xor',
        'an ACTIVE session is studying XOR on a break',
      );
    }
    if (s.status === 'ENDED' && (s.currentSegmentStartedAt !== null || s.breakEndsAt !== null)) {
      throw new IntegrityError('ss_ended_clean', 'an ENDED session has nothing open');
    }
    if (s.endedAt !== null && s.endedAt < s.startedAt) {
      throw new IntegrityError('ss_time_order', 'ended_at before started_at');
    }
  }

  private validateIntervals(userId: string, segments: SegmentRow[], breaks: BreakRow[]): void {
    const segs = segments.filter((g) => g.userId === userId);
    const brks = breaks.filter((b) => b.userId === userId);

    for (const g of segs) {
      if ((g.endedAt === null) !== (g.endReason === null))
        throw new IntegrityError('seg_close_consistent', 'ended_at ⇔ end_reason');
      if (g.endedAt !== null && g.endedAt < g.startedAt)
        throw new IntegrityError('seg_time_order', 'segment ends before it starts');
    }
    const openSegs = segs.filter((g) => g.endedAt === null);
    if (openSegs.length > 1)
      throw new IntegrityError('study_segments_one_open_per_user', 'more than one open segment');

    for (const b of brks) {
      if (!isBreakMinutes(b.durationMinutes))
        throw new IntegrityError(
          'brk_duration_allowed',
          `break of ${String(b.durationMinutes)} min`,
        );
      if (b.endsAt !== b.startedAt + minutesToMs(b.durationMinutes))
        throw new IntegrityError('brk_ends_exact', 'ends_at ≠ started_at + duration');
      if ((b.closedAt === null) !== (b.closeReason === null))
        throw new IntegrityError('brk_close_consistent', 'closed_at ⇔ close_reason');
      if (
        b.closedAt !== null &&
        (b.closedAt < b.startedAt || b.closedAt > b.endsAt + BREAK_OVER_IDLE_TIMEOUT_MS)
      )
        throw new IntegrityError('brk_close_window', 'break closed outside its window');
      if (b.closeReason === 'RESUMED' && b.closedAt! < b.endsAt)
        throw new IntegrityError('brk_resume_only_after_end', 'resumed before the countdown ended');
    }
    const openBreaksBySession = new Map<string, number>();
    for (const b of brks.filter((x) => x.closedAt === null)) {
      openBreaksBySession.set(b.sessionId, (openBreaksBySession.get(b.sessionId) ?? 0) + 1);
    }
    for (const count of openBreaksBySession.values()) {
      if (count > 1)
        throw new IntegrityError('study_breaks_one_open_per_session', 'two open breaks');
    }

    // seg_no_overlap_per_user / brk_no_overlap_per_user / audit A (segment vs break) — R3
    const intervals = [
      ...segs.map((g) => ({ kind: 'segment', start: g.startedAt, end: g.endedAt })),
      ...brks.map((b) => ({ kind: 'break', start: b.startedAt, end: b.closedAt })),
    ].filter((i) => i.end === null || i.end > i.start); // zero-length intervals are empty
    for (let i = 0; i < intervals.length; i++) {
      for (let j = i + 1; j < intervals.length; j++) {
        const a = intervals[i]!;
        const b = intervals[j]!;
        if (overlaps(a.start, a.end, b.start, b.end)) {
          const name =
            a.kind === 'segment' && b.kind === 'segment'
              ? 'seg_no_overlap_per_user'
              : a.kind === 'break' && b.kind === 'break'
                ? 'brk_no_overlap_per_user'
                : 'segment_break_no_overlap';
          throw new IntegrityError(name, 'intervals of one user overlap');
        }
      }
    }
  }

  private requireSession(session: SessionRow | null): SessionRow {
    if (!session)
      throw new IntegrityError('session_exists', 'transition needs an existing session');
    return session;
  }
}
