import { describe, it, expect, vi } from 'vitest';
import { LruMemoCache } from '../lru-memo-cache.js';

describe('LruMemoCache', () => {
  it('stores and retrieves values by key', () => {
    const cache = new LruMemoCache<string, number>(10);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least-recently-used entry once at capacity', () => {
    const cache = new LruMemoCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('refreshes LRU order on read, protecting recently-accessed entries from eviction', () => {
    const cache = new LruMemoCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // touch 'a' so 'b' becomes the oldest
    cache.set('c', 3);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('reports null speedup until at least one hit and one miss are recorded', () => {
    const cache = new LruMemoCache<string, number>(10);
    expect(cache.metrics().measuredSpeedupPercent).toBeNull();

    cache.recordMiss(5);
    expect(cache.metrics().measuredSpeedupPercent).toBeNull();

    cache.recordHit(1);
    const metrics = cache.metrics();
    expect(metrics.cacheHits).toBe(1);
    expect(metrics.cacheMisses).toBe(1);
    expect(metrics.measuredSpeedupPercent).toBeCloseTo(80); // (5 - 1) / 5 * 100
  });

  it('resets storage and counters on clear', () => {
    const cache = new LruMemoCache<string, number>(10);
    cache.set('a', 1);
    cache.recordHit(1);
    cache.recordMiss(2);

    cache.clear();

    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
    const metrics = cache.metrics();
    expect(metrics.cacheHits).toBe(0);
    expect(metrics.cacheMisses).toBe(0);
    expect(metrics.measuredSpeedupPercent).toBeNull();
  });
});

describe('LruMemoCache serialization', () => {
  it('round-trips entries and configuration through a JSON snapshot', () => {
    const cache = new LruMemoCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);

    const restored = LruMemoCache.hydrateCache<string, number>(cache.serializeCache());

    expect(restored.size).toBe(2);
    expect(restored.get('a')).toBe(1);
    expect(restored.get('b')).toBe(2);
  });

  it('preserves LRU recency order so eviction after hydration drops the coldest entry', () => {
    const cache = new LruMemoCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // 'a' is now the most recent, 'b' the coldest

    const restored = LruMemoCache.hydrateCache<string, number>(cache.serializeCache());
    restored.set('c', 3);

    expect(restored.get('a')).toBe(1);
    expect(restored.get('b')).toBeUndefined();
    expect(restored.get('c')).toBe(3);
  });

  it('restores absolute expiries instead of restarting the TTL', () => {
    vi.useFakeTimers();
    try {
      const cache = new LruMemoCache<string, number>(10);
      cache.set('a', 1, 1000);
      vi.advanceTimersByTime(600);

      const restored = LruMemoCache.hydrateCache<string, number>(cache.serializeCache());
      // 400ms of the original TTL remains, not a fresh 1000ms.
      vi.advanceTimersByTime(399);
      expect(restored.get('a')).toBe(1);
      vi.advanceTimersByTime(1);
      expect(restored.get('a')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops entries whose expiry already passed while the snapshot was in transit', () => {
    vi.useFakeTimers();
    try {
      const cache = new LruMemoCache<string, number>(10);
      cache.set('short', 1, 100);
      cache.set('forever', 2);

      const json = cache.serializeCache();
      vi.advanceTimersByTime(5000);

      const restored = LruMemoCache.hydrateCache<string, number>(json);
      expect(restored.size).toBe(1);
      expect(restored.get('short')).toBeUndefined();
      expect(restored.get('forever')).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the default ttl across the round trip', () => {
    vi.useFakeTimers();
    try {
      const cache = new LruMemoCache<string, number>({ maxEntries: 10, ttlMs: 1000 });
      cache.set('a', 1);

      const restored = LruMemoCache.hydrateCache<string, number>(cache.serializeCache());
      restored.set('b', 2); // picks up the restored default ttl
      vi.advanceTimersByTime(1001);

      expect(restored.get('a')).toBeUndefined();
      expect(restored.get('b')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a hydrated cache with zeroed metrics rather than invented counters', () => {
    const cache = new LruMemoCache<string, number>(10);
    cache.set('a', 1);
    cache.recordHit(1);
    cache.recordMiss(5);

    const restored = LruMemoCache.hydrateCache<string, number>(cache.serializeCache());
    const metrics = restored.metrics();

    expect(metrics.cacheHits).toBe(0);
    expect(metrics.cacheMisses).toBe(0);
    expect(metrics.measuredSpeedupPercent).toBeNull();
  });

  it('rejects a snapshot from an unsupported version', () => {
    expect(() =>
      LruMemoCache.hydrateCache<string, number>(
        JSON.stringify({ version: 99, maxEntries: 10, entries: [] })
      )
    ).toThrow(RangeError);
  });

  it('rejects malformed snapshots instead of returning a half-built cache', () => {
    expect(() => LruMemoCache.hydrateCache<string, number>('not json')).toThrow(RangeError);
    expect(() => LruMemoCache.hydrateCache<string, number>('[]')).toThrow(RangeError);
    expect(() =>
      LruMemoCache.hydrateCache<string, number>(JSON.stringify({ version: 1, maxEntries: 0, entries: [] }))
    ).toThrow(RangeError);
    expect(() =>
      LruMemoCache.hydrateCache<string, number>(JSON.stringify({ version: 1, maxEntries: 10 }))
    ).toThrow(RangeError);
  });

  it('keeps at most maxEntries when a snapshot claims more', () => {
    const snapshot = JSON.stringify({
      version: 1,
      maxEntries: 2,
      entries: [
        { key: 'a', value: 1, expiresAt: null },
        { key: 'b', value: 2, expiresAt: null },
        { key: 'c', value: 3, expiresAt: null },
      ],
    });

    const restored = LruMemoCache.hydrateCache<string, number>(snapshot);
    expect(restored.size).toBe(2);
    expect(restored.get('a')).toBeUndefined();
    expect(restored.get('b')).toBe(2);
    expect(restored.get('c')).toBe(3);
  });
});

describe('LruMemoCache TTL', () => {
  it('returns an entry before its ttl elapses and drops it afterwards', () => {
    vi.useFakeTimers();
    try {
      const cache = new LruMemoCache<string, number>(10);
      cache.set('a', 1, 1000);
      vi.advanceTimersByTime(999);
      expect(cache.get('a')).toBe(1);
      vi.advanceTimersByTime(1);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never expires entries set without a ttl, and re-set replaces the ttl', () => {
    vi.useFakeTimers();
    try {
      const cache = new LruMemoCache<string, number>(10);
      cache.set('forever', 1);
      cache.set('a', 1, 100);
      cache.set('a', 2);
      vi.advanceTimersByTime(10_000);
      expect(cache.get('forever')).toBe(1);
      expect(cache.get('a')).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a non-positive ttl', () => {
    const cache = new LruMemoCache<string, number>(10);
    expect(() => cache.set('a', 1, 0)).toThrow(RangeError);
    expect(() => cache.set('a', 1, NaN)).toThrow(RangeError);
  });
});
