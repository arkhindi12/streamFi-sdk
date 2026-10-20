/**
 * Generic LRU cache with hit/miss timing instrumentation.
 *
 * Shared by the memoized stream-analytics modules (`Module26`, `Module36`,
 * `Module48`) so the eviction and speedup-measurement logic lives in one
 * place instead of being re-implemented identically in each of them.
 */

export interface MemoCacheMetrics {
  cacheHits: number;
  cacheMisses: number;
  /**
   * `(avgMissMs - avgHitMs) / avgMissMs * 100`, measured from this
   * instance's own accumulated hit/miss timings - not a fixed assumption.
   * `null` until at least one hit and one miss have both been recorded.
   */
  measuredSpeedupPercent: number | null;
}

export interface LruMemoCacheOptions {
  /** Entries kept before the least-recently-used one is evicted. */
  maxEntries: number;
  /**
   * Default time-to-live in milliseconds for `set()` calls that pass no
   * `ttlMs`. Omit for entries that never expire by default.
   */
  ttlMs?: number;
}

/**
 * Bumped whenever the snapshot layout changes. Hydration refuses snapshots
 * written by a different version instead of guessing at their shape.
 */
export const LRU_CACHE_SNAPSHOT_VERSION = 1;

export interface LruMemoCacheEntry<V> {
  key: unknown;
  value: V;
  /** Absolute epoch-ms expiry, or `null` for entries that never expire. */
  expiresAt: number | null;
}

export interface LruMemoCacheSnapshot<V> {
  version: number;
  maxEntries: number;
  ttlMs?: number;
  /** Ordered oldest → newest so replaying them restores recency. */
  entries: LruMemoCacheEntry<V>[];
}

export class LruMemoCache<K, V> {
  private readonly store = new Map<K, V>();
  /** Absolute expiry (epoch ms) for entries stored with a `ttlMs`. */
  private readonly expiresAt = new Map<K, number>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private hitExecutionTimeMs = 0;
  private missExecutionTimeMs = 0;
  private readonly maxSize: number;
  private readonly defaultTtlMs: number | undefined;

  /**
   * Accepts either a bare max entry count (the original form) or
   * {@link LruMemoCacheOptions}.
   */
  constructor(options: number | LruMemoCacheOptions) {
    const resolved = typeof options === 'number' ? { maxEntries: options } : options;
    this.maxSize = resolved.maxEntries;
    this.defaultTtlMs = resolved.ttlMs;
    if (this.defaultTtlMs !== undefined && (!Number.isFinite(this.defaultTtlMs) || this.defaultTtlMs <= 0)) {
      throw new RangeError('LruMemoCache ttlMs must be a positive finite number');
    }
  }

  get size(): number {
    return this.store.size;
  }

  private isExpired(key: K): boolean {
    const expiry = this.expiresAt.get(key);
    return expiry !== undefined && Date.now() >= expiry;
  }

  private remove(key: K): void {
    this.store.delete(key);
    this.expiresAt.delete(key);
  }

  /**
   * Look up a key, refreshing its LRU position on hit. An entry past its
   * `ttlMs` is dropped and reported as a miss.
   */
  get(key: K): V | undefined {
    if (this.isExpired(key)) {
      this.remove(key);
      return undefined;
    }
    const value = this.store.get(key);
    if (value !== undefined) {
      this.store.delete(key);
      this.store.set(key, value);
    }
    return value;
  }

  /**
   * Insert a key, evicting the least-recently-used entry if at capacity.
   *
   * @param ttlMs Optional time-to-live in milliseconds. Once elapsed the entry
   *   is no longer returned by `get()`. Defaults to the cache's configured
   *   `ttlMs`; if that is also unset the entry never expires. Re-setting a key
   *   replaces any previous TTL.
   */
  set(key: K, value: V, ttlMs: number | undefined = this.defaultTtlMs): void {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new RangeError('LruMemoCache ttlMs must be a positive finite number');
    }
    if (this.store.has(key)) {
      this.remove(key);
    } else if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.remove(oldest);
    }
    this.store.set(key, value);
    if (ttlMs !== undefined) this.expiresAt.set(key, Date.now() + ttlMs);
  }

  recordHit(elapsedMs: number): void {
    this.cacheHits++;
    this.hitExecutionTimeMs += elapsedMs;
  }

  recordMiss(elapsedMs: number): void {
    this.cacheMisses++;
    this.missExecutionTimeMs += elapsedMs;
  }

  clear(): void {
    this.store.clear();
    this.expiresAt.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.hitExecutionTimeMs = 0;
    this.missExecutionTimeMs = 0;
  }

  metrics(): MemoCacheMetrics {
    const avgHitMs = this.cacheHits > 0 ? this.hitExecutionTimeMs / this.cacheHits : null;
    const avgMissMs = this.cacheMisses > 0 ? this.missExecutionTimeMs / this.cacheMisses : null;
    const measuredSpeedupPercent =
      avgHitMs !== null && avgMissMs !== null && avgMissMs > 0
        ? ((avgMissMs - avgHitMs) / avgMissMs) * 100
        : null;

    return { cacheHits: this.cacheHits, cacheMisses: this.cacheMisses, measuredSpeedupPercent };
  }

  /**
   * Snapshot the cache as a versioned JSON string.
   *
   * Entries are written oldest → newest so that replaying them in order
   * restores the LRU recency order, and expiries are written as absolute
   * epoch-ms deadlines rather than remaining TTLs: a snapshot that sits in a
   * transport for a while must not hand entries a fresh lease on life.
   *
   * Hit/miss counters are deliberately not serialized. They describe the
   * process that produced them, and inventing numbers for a cache that has not
   * served a single request yet would make `metrics()` lie.
   */
  serializeCache(): string {
    const entries: LruMemoCacheEntry<V>[] = [];
    for (const [key, value] of this.store) {
      // `undefined` is indistinguishable from a miss through `get()`, so it is
      // not worth carrying across a round trip.
      if (value === undefined) continue;
      const expiry = this.expiresAt.get(key);
      entries.push({ key, value, expiresAt: expiry === undefined ? null : expiry });
    }

    const snapshot: LruMemoCacheSnapshot<V> = {
      version: LRU_CACHE_SNAPSHOT_VERSION,
      maxEntries: this.maxSize,
      ...(this.defaultTtlMs !== undefined ? { ttlMs: this.defaultTtlMs } : {}),
      entries,
    };

    return JSON.stringify(snapshot);
  }

  /**
   * Rebuild a cache from a snapshot produced by {@link serializeCache}.
   *
   * The restored cache keeps the original `maxEntries`/`ttlMs` configuration,
   * drops entries whose absolute expiry has already passed, and starts with
   * zeroed metrics. A snapshot from an unknown version, or one that is not a
   * well-formed object, throws `RangeError` rather than yielding a half-built
   * cache.
   */
  static hydrateCache<K, V>(json: string): LruMemoCache<K, V> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new RangeError('LruMemoCache snapshot is not valid JSON');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new RangeError('LruMemoCache snapshot must be an object');
    }

    const snapshot = parsed as Partial<LruMemoCacheSnapshot<V>>;
    if (snapshot.version !== LRU_CACHE_SNAPSHOT_VERSION) {
      throw new RangeError(
        `LruMemoCache snapshot version ${String(snapshot.version)} is not supported (expected ${LRU_CACHE_SNAPSHOT_VERSION})`
      );
    }

    const maxEntries = Number(snapshot.maxEntries);
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('LruMemoCache snapshot has an invalid maxEntries');
    }
    if (snapshot.ttlMs !== undefined && (!Number.isFinite(snapshot.ttlMs) || (snapshot.ttlMs as number) <= 0)) {
      throw new RangeError('LruMemoCache snapshot has an invalid ttlMs');
    }
    if (!Array.isArray(snapshot.entries)) {
      throw new RangeError('LruMemoCache snapshot has no entries array');
    }

    const cache = new LruMemoCache<K, V>(
      snapshot.ttlMs !== undefined ? { maxEntries, ttlMs: snapshot.ttlMs as number } : { maxEntries }
    );

    const now = Date.now();
    // A tampered snapshot can claim more entries than the cache may hold; keep
    // the newest ones, which is what replaying in order would have produced.
    const usable = snapshot.entries
      .filter((entry): entry is LruMemoCacheEntry<V> => !!entry && typeof entry === 'object')
      .slice(-maxEntries);

    for (const entry of usable) {
      if (!('key' in entry)) {
        throw new RangeError('LruMemoCache snapshot entry is missing a key');
      }
      const expiresAt = entry.expiresAt ?? null;
      if (expiresAt !== null && !Number.isFinite(expiresAt)) {
        throw new RangeError('LruMemoCache snapshot entry has an invalid expiresAt');
      }
      // Dead on arrival: keeping it would only delay the miss by one lookup.
      if (expiresAt !== null && expiresAt <= now) continue;

      cache.store.set(entry.key as K, entry.value);
      if (expiresAt !== null) cache.expiresAt.set(entry.key as K, expiresAt);
    }

    return cache;
  }
}