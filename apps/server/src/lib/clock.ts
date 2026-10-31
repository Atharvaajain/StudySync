/**
 * The injected server clock (ARCHITECTURE §9.1, principle 1). Domain code never calls
 * Date.now(); every instant comes from a Clock so tests can control time.
 */
export interface Clock {
  /** Epoch milliseconds (UTC). */
  now(): number;
}

/** A clock that can be moved forward (tests, and the E2E test clock). */
export interface AdjustableClock extends Clock {
  advance(ms: number): void;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Frozen clock for deterministic tests: time only moves when advanced. */
export class ManualClock implements AdjustableClock {
  private current: number;
  constructor(start: number) {
    this.current = start;
  }
  now(): number {
    return this.current;
  }
  set(epochMs: number): void {
    this.current = epochMs;
  }
  advance(ms: number): void {
    if (ms < 0) throw new Error('Clock cannot move backwards');
    this.current += ms;
  }
}

/** Real time plus an offset: time flows normally and can jump forward (E2E test clock). */
export class OffsetClock implements AdjustableClock {
  private offset = 0;
  now(): number {
    return Date.now() + this.offset;
  }
  advance(ms: number): void {
    if (ms < 0) throw new Error('Clock cannot move backwards');
    this.offset += ms;
  }
}
