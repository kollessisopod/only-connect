/**
 * Tiny in-memory token buckets (per key: an IP, a socket id, "global"). Used for the admin login and the
 * public socket events; nothing here is persisted, so a restart clears every bucket.
 */
export interface TokenBucketOptions {
  /** Burst size: tokens a fresh key starts with. */
  capacity: number;
  /** Tokens refilled per second. */
  refillPerSecond: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucket {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refill: number;
  private readonly now: () => number;
  private lastPrune = 0;

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity;
    this.refill = opts.refillPerSecond;
    this.now = opts.now ?? (() => Date.now());
  }

  private bucket(key: string): Bucket {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, updatedAt: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + ((t - b.updatedAt) / 1000) * this.refill);
      b.updatedAt = t;
    }
    if (t - this.lastPrune > 60_000) this.prune(t);
    return b;
  }

  /** Full buckets carry no information: drop them so the map cannot grow without bound. */
  private prune(t: number): void {
    this.lastPrune = t;
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((t - b.updatedAt) / 1000) * this.refill >= this.capacity) this.buckets.delete(key);
    }
  }

  /** Tokens currently available for `key` (fractional). */
  remaining(key: string): number {
    return this.bucket(key).tokens;
  }

  /** Take one token; false (and nothing taken) when the bucket is empty. */
  tryTake(key: string): boolean {
    const b = this.bucket(key);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Seconds until one token is available for `key` (0 when it already is). */
  retryAfterSeconds(key: string): number {
    const b = this.bucket(key);
    if (b.tokens >= 1) return 0;
    return Math.ceil((1 - b.tokens) / this.refill);
  }

  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Login throttle: a wrong password costs a token from the client's bucket and from the global one; the
 * route refuses (429) while either is empty, so one attacker cannot try the password at full speed and a
 * distributed attack is bounded too. Successful logins cost nothing.
 */
export const loginLimits = {
  perClient: new TokenBucket({ capacity: 5, refillPerSecond: 1 / 12 }), // 5 wrong guesses, then one per 12 s
  global: new TokenBucket({ capacity: 60, refillPerSecond: 0.5 }),
};

/** Public socket throttles (per socket id, plus a per-address bucket for joins). */
export const socketLimits = {
  /** join / leave per socket: a reconnecting phone needs a handful, never dozens. */
  presence: new TokenBucket({ capacity: 6, refillPerSecond: 0.25 }),
  /** joins per client address: a venue NAT may put every phone behind one address. */
  joinsPerAddress: new TokenBucket({ capacity: 40, refillPerSecond: 1 }),
  /** buzz / wall taps per socket: a human cannot exceed this, a flood can. */
  play: new TokenBucket({ capacity: 15, refillPerSecond: 8 }),
};

export function resetRateLimitsForTests(): void {
  for (const group of [loginLimits, socketLimits]) for (const bucket of Object.values(group)) bucket.reset();
}
