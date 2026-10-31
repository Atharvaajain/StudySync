/**
 * Server-clock offset estimator (ARCHITECTURE §16.2). The browser's own clock is never
 * trusted for timer logic: every timer on screen is `server timestamps` vs `corrected now`.
 *
 * - Round-trip samples (sync_state / join_room acks): offset = serverNow − midpoint(send,
 *   receive). Unbiased; they refine the estimate (median of the last samples).
 * - Push samples (session_state): serverNow − receivedAt is biased by the network latency, so
 *   pushes are only used to detect a clock jump (> 5 s, e.g. the E2E test clock), which
 *   replaces the estimate immediately.
 */
const MAX_SAMPLES = 7;
const JUMP_THRESHOLD_MS = 5_000;

class ServerClock {
  private offsetMs = 0;
  private samples: number[] = [];

  sampleRoundTrip(sentAt: number, serverNowIso: string, receivedAt: number): void {
    this.add(Date.parse(serverNowIso) - (sentAt + receivedAt) / 2);
  }

  samplePush(serverNowIso: string, receivedAt: number = Date.now()): void {
    const sample = Date.parse(serverNowIso) - receivedAt;
    if (this.samples.length === 0 || Math.abs(sample - this.offsetMs) > JUMP_THRESHOLD_MS)
      this.add(sample);
  }

  /** Corrected "now" in epoch ms. */
  now(): number {
    return Date.now() + this.offsetMs;
  }

  get offset(): number {
    return this.offsetMs;
  }

  private add(sample: number): void {
    if (!Number.isFinite(sample)) return;
    if (this.samples.length === 0 || Math.abs(sample - this.offsetMs) > JUMP_THRESHOLD_MS) {
      this.samples = [sample];
    } else {
      this.samples = [...this.samples, sample].slice(-MAX_SAMPLES);
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    this.offsetMs = sorted[Math.floor(sorted.length / 2)]!;
  }
}

export const serverClock = new ServerClock();
