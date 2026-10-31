/**
 * Per-socket token buckets (ARCHITECTURE §12.3, API_DESIGN §10). Rate limiting is about real
 * wall time, so it uses its own clock (not the domain clock that tests fast-forward).
 */
export type RateBucket = 'timer' | 'room' | 'sync';

export interface BucketConfig {
  capacity: number;
  perMs: number;
}

export type RateLimitConfig = Record<RateBucket, BucketConfig>;

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  timer: { capacity: 30, perMs: 60_000 },
  room: { capacity: 20, perMs: 60_000 },
  sync: { capacity: 30, perMs: 60_000 },
};

interface BucketState {
  tokens: number;
  updatedAt: number;
}

export class SocketRateLimiter {
  private readonly state = new Map<string, BucketState>();

  constructor(
    private readonly config: RateLimitConfig = DEFAULT_RATE_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Consumes one token; returns false when the socket is over its limit. */
  take(socketId: string, bucket: RateBucket): boolean {
    const { capacity, perMs } = this.config[bucket];
    const key = `${socketId}:${bucket}`;
    const t = this.now();
    const current = this.state.get(key) ?? { tokens: capacity, updatedAt: t };
    const refilled = Math.min(
      capacity,
      current.tokens + ((t - current.updatedAt) * capacity) / perMs,
    );
    if (refilled < 1) {
      this.state.set(key, { tokens: refilled, updatedAt: t });
      return false;
    }
    this.state.set(key, { tokens: refilled - 1, updatedAt: t });
    return true;
  }

  forget(socketId: string): void {
    for (const bucket of Object.keys(this.config) as RateBucket[]) {
      this.state.delete(`${socketId}:${bucket}`);
    }
  }
}
