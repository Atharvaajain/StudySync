/**
 * The restart-safe backstop for deadlines (ARCHITECTURE §13.6, §13.9; DATABASE_DESIGN §6.7–§6.8).
 *
 * Every tick (5 s, and once at boot):
 *   1. Liveness lease: one batched UPDATE sets `last_seen_at = now` for the sessions that are
 *      live on THIS instance (solo: any socket; room: present in that room — D-7).
 *   2. Sweep: users whose grace or idle deadline is due, or whose lease went stale (a crashed
 *      instance can't refresh it), are reconciled on their own queue with
 *      `pg_try_advisory_xact_lock` — a user with a command in flight is simply skipped.
 *
 * Ticks never overlap. The test clock runs inside the same exclusive section, so a clock jump
 * refreshes the lease of live users before anything can see it as stale.
 */
import { SWEEP_INTERVAL_MS } from '@studysync/shared';
import type { Clock } from '../../lib/clock';
import type { Db } from '../../lib/db';
import type { KeyedQueue } from '../../lib/keyedQueue';
import type { Logger } from '../../lib/logger';
import type { PresenceStore } from '../presence/presenceStore';
import { refreshLease, sweepCandidates } from './sessionRepository';
import type { SessionService } from './sessionService';

export class Maintenance {
  private timer: NodeJS.Timeout | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: {
      db: Db;
      clock: Clock;
      presence: PresenceStore;
      sessions: SessionService;
      queue: KeyedQueue;
      logger: Logger;
    },
  ) {}

  start(intervalMs: number = SWEEP_INTERVAL_MS): void {
    this.stop();
    void this.tick(); // at boot: overdue deadlines are applied immediately (§13.9)
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs `task` with no tick in between (ticks and the test clock are serialized). */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** One lease refresh + sweep. Errors are logged; the next tick retries. */
  tick(): Promise<void> {
    return this.exclusive(async () => {
      try {
        await this.refreshLease();
        await this.sweep();
      } catch (err) {
        this.deps.logger.error({ err }, 'maintenance tick failed');
      }
    });
  }

  /** §6.8 for the users live on this instance. */
  async refreshLease(): Promise<void> {
    const { presence, db, clock } = this.deps;
    await refreshLease(db, clock.now(), presence.connectedUsers(), presence.presentPairs());
  }

  private async sweep(): Promise<void> {
    const { db, clock, sessions, queue } = this.deps;
    const candidates = await sweepCandidates(db, clock.now());
    await Promise.all(candidates.map((userId) => queue.run(userId, () => sessions.sweep(userId))));
  }
}
