import type { Clock } from './clock';

/**
 * Deadline scheduler (ARCHITECTURE §13.7, "timers are only triggers").
 * Tasks are keyed by an instant on the injected Clock, not by a delay, so a test clock jump
 * followed by `runDue()` fires exactly the tasks whose deadline has passed.
 */
export interface DeadlineScheduler {
  /** Schedule (or replace) the task for `key` at instant `at`. */
  schedule(key: string, at: number, task: () => void): void;
  cancel(key: string): void;
  /** Run every task whose deadline is ≤ the clock's now. */
  runDue(): void;
  has(key: string): boolean;
  dispose(): void;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

interface Entry {
  at: number;
  task: () => void;
  handle: ReturnType<typeof setTimeout> | null;
}

export class TimerScheduler implements DeadlineScheduler {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly clock: Clock,
    private readonly onError: (error: unknown, key: string) => void = () => {},
  ) {}

  schedule(key: string, at: number, task: () => void): void {
    this.cancel(key);
    const entry: Entry = { at, task, handle: null };
    this.entries.set(key, entry);
    this.arm(key, entry);
  }

  cancel(key: string): void {
    const entry = this.entries.get(key);
    if (entry?.handle) clearTimeout(entry.handle);
    this.entries.delete(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  runDue(): void {
    const now = this.clock.now();
    const due = [...this.entries.entries()]
      .filter(([, e]) => e.at <= now)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [key] of due) this.fire(key);
  }

  dispose(): void {
    for (const key of [...this.entries.keys()]) this.cancel(key);
  }

  private arm(key: string, entry: Entry): void {
    const delay = Math.min(Math.max(0, entry.at - this.clock.now()), MAX_TIMEOUT_MS);
    entry.handle = setTimeout(() => {
      // The clock may be frozen or offset: only fire when the deadline has really passed.
      if (this.entries.get(key) !== entry) return;
      if (this.clock.now() >= entry.at) this.fire(key);
      else this.arm(key, entry);
    }, delay);
    entry.handle.unref?.();
  }

  private fire(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.handle) clearTimeout(entry.handle);
    try {
      entry.task();
    } catch (error) {
      this.onError(error, key);
    }
  }
}
