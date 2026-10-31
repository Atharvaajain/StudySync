/** Unit tests: per-user queue, deadline scheduler, rate limiter, environment guard. */
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../src/config/env';
import { ManualClock } from '../../src/lib/clock';
import { KeyedQueue } from '../../src/lib/keyedQueue';
import { TimerScheduler } from '../../src/lib/scheduler';
import { SocketRateLimiter } from '../../src/realtime/rateLimiter';

describe('KeyedQueue (per-user serialization, §13.8)', () => {
  it('runs tasks for the same key strictly in order', async () => {
    const q = new KeyedQueue();
    const order: string[] = [];
    const slow = (label: string, ms: number) => () =>
      new Promise<void>((r) =>
        setTimeout(() => {
          order.push(label);
          r();
        }, ms),
      );
    await Promise.all([
      q.run('alice', slow('a1', 30)),
      q.run('alice', slow('a2', 1)),
      q.run('alice', slow('a3', 10)),
    ]);
    expect(order).toEqual(['a1', 'a2', 'a3']);
  });

  it('a failing task does not block the next one', async () => {
    const q = new KeyedQueue();
    await expect(q.run('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(q.run('k', () => 42)).resolves.toBe(42);
  });

  it('different keys run independently', async () => {
    const q = new KeyedQueue();
    const order: string[] = [];
    await Promise.all([
      q.run(
        'alice',
        () => new Promise<void>((r) => setTimeout(() => (order.push('alice'), r()), 30)),
      ),
      q.run('bob', () => {
        order.push('bob');
      }),
    ]);
    expect(order).toEqual(['bob', 'alice']);
  });
});

describe('TimerScheduler (deadlines are instants on the injected clock)', () => {
  it('runDue fires only tasks whose deadline has passed, in deadline order', () => {
    const clock = new ManualClock(1_000);
    const s = new TimerScheduler(clock);
    const fired: string[] = [];
    s.schedule('late', 5_000, () => fired.push('late'));
    s.schedule('early', 2_000, () => fired.push('early'));
    clock.advance(500);
    s.runDue();
    expect(fired).toEqual([]);
    clock.advance(10_000);
    s.runDue();
    expect(fired).toEqual(['early', 'late']);
    s.dispose();
  });

  it('cancel and replace by key', () => {
    const clock = new ManualClock(0);
    const s = new TimerScheduler(clock);
    const fired: string[] = [];
    s.schedule('k', 100, () => fired.push('first'));
    s.schedule('k', 100, () => fired.push('second'));
    s.schedule('x', 100, () => fired.push('cancelled'));
    s.cancel('x');
    clock.advance(100);
    s.runDue();
    expect(fired).toEqual(['second']);
    s.dispose();
  });

  it('a real timer firing early against a frozen clock re-arms instead of running', async () => {
    vi.useFakeTimers();
    try {
      const clock = new ManualClock(0);
      const s = new TimerScheduler(clock);
      const task = vi.fn();
      s.schedule('k', 1_000, task);
      await vi.advanceTimersByTimeAsync(1_000); // real time passed, domain clock did not
      expect(task).not.toHaveBeenCalled(); // not fired early: it re-armed for the remaining 1 000 ms
      clock.advance(1_000);
      await vi.advanceTimersByTimeAsync(1_000); // the re-armed timer elapses; the deadline has now passed
      expect(task).toHaveBeenCalledOnce();
      s.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SocketRateLimiter', () => {
  it('allows the capacity, then rejects, then refills over time', () => {
    let now = 0;
    const limiter = new SocketRateLimiter(
      {
        timer: { capacity: 2, perMs: 1_000 },
        room: { capacity: 1, perMs: 1_000 },
        sync: { capacity: 1, perMs: 1_000 },
      },
      () => now,
    );
    expect(limiter.take('s1', 'timer')).toBe(true);
    expect(limiter.take('s1', 'timer')).toBe(true);
    expect(limiter.take('s1', 'timer')).toBe(false);
    expect(limiter.take('s2', 'timer')).toBe(true); // per socket
    now += 500; // half the window → one token back
    expect(limiter.take('s1', 'timer')).toBe(true);
    expect(limiter.take('s1', 'timer')).toBe(false);
  });
});

describe('environment guard (§17.6)', () => {
  it('has safe defaults', () => {
    expect(loadEnv({})).toMatchObject({
      NODE_ENV: 'development',
      PORT: 4000,
      HOST: '127.0.0.1',
      ENABLE_TEST_CLOCK: false,
    });
  });

  it('refuses production: the prototype has no authentication', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(
      /must not run with NODE_ENV=production/,
    );
  });

  it('refuses the test clock outside NODE_ENV=test', () => {
    expect(() => loadEnv({ NODE_ENV: 'development', ENABLE_TEST_CLOCK: 'true' })).toThrow(
      /only allowed with NODE_ENV=test/,
    );
    expect(loadEnv({ NODE_ENV: 'test', ENABLE_TEST_CLOCK: 'true' }).ENABLE_TEST_CLOCK).toBe(true);
  });
});
