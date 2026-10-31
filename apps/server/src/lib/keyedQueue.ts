/**
 * Per-key FIFO queue (ARCHITECTURE §12.3, §13.8): every command, presence change and scheduled
 * task for one user runs strictly in order, never interleaved. Different users run in parallel.
 * Phase 1 adds the database-level per-user advisory lock behind the same call sites.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Number of keys with work queued (diagnostics / tests). */
  get size(): number {
    return this.tails.size;
  }
}
