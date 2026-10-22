/** In-memory sliding-window limiter (single instance; Phase 1B may move this to shared storage). */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly opts: { windowMs: number; max: number; maxKeys?: number },
    private readonly now: () => number = Date.now,
  ) {}

  private prune(key: string, t: number): number[] {
    const arr = (this.hits.get(key) ?? []).filter((x) => x > t - this.opts.windowMs);
    if (arr.length) this.hits.set(key, arr);
    else this.hits.delete(key);
    return arr;
  }

  /** Memory bound: once the table is full, unseen keys share one overflow bucket (for check AND record). */
  private keyFor(key: string): string {
    return !this.hits.has(key) && this.hits.size >= (this.opts.maxKeys ?? 10_000) ? "__overflow__" : key;
  }

  /** Is another attempt currently allowed for `key`? Does not record anything. */
  check(rawKey: string): { allowed: boolean; retryAfterSec: number } {
    const key = this.keyFor(rawKey);
    const t = this.now();
    const arr = this.prune(key, t);
    if (arr.length < this.opts.max) return { allowed: true, retryAfterSec: 0 };
    const oldest = arr[0]!;
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + this.opts.windowMs - t) / 1000)) };
  }

  /** Records one event for `key`. */
  record(rawKey: string): void {
    const key = this.keyFor(rawKey);
    const t = this.now();
    const arr = this.prune(key, t);
    arr.push(t);
    this.hits.set(key, arr);
  }

  /** check + record in one step (for request-rate limiting). */
  take(key: string): { allowed: boolean; retryAfterSec: number } {
    const r = this.check(key);
    if (r.allowed) this.record(key);
    return r;
  }

  reset(key?: string): void {
    if (key) this.hits.delete(key);
    else this.hits.clear();
  }
}
