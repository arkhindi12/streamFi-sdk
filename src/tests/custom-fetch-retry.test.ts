import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Account, Asset, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { ConduitClient } from '../client.js';
import { clearServerCache } from '../soroban.js';
import {
  unregisterCustomFetch,
  setCustomFetchRetryPolicy,
  resetCustomFetchRetryPolicy,
} from '../custom-fetch.js';

const RPC = 'https://rpc.retry.test';
const FACTORY = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';

/** A JSON-RPC result the SDK accepts for getLatestLedger. */
const LEDGER = { sequence: 42, id: 'abc', protocolVersion: 21 };

function ok(result: unknown = LEDGER): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fail(status: number): Response {
  return new Response(JSON.stringify({ error: 'upstream' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Sequence of responses, one per call; the last one repeats. */
function sequence(...responses: Array<Response | Error>): typeof fetch {
  let i = 0;
  return (async () => {
    // Test helper: the array is never empty, so the index always resolves.
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof fetch;
}

function client(customFetch: typeof fetch): ConduitClient {
  return new ConduitClient({ network: 'testnet', rpcUrl: RPC, factoryAddress: FACTORY, customFetch });
}

describe('customFetch retry on transient 5xx (#980)', () => {
  beforeEach(() => {
    // No real waiting in tests; the policy is what is under test.
    setCustomFetchRetryPolicy({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 });
  });

  afterEach(() => {
    unregisterCustomFetch(RPC);
    clearServerCache();
    resetCustomFetchRetryPolicy();
  });

  it('retries a read-only RPC call that answers 503, then succeeds', async () => {
    const fetchImpl = vi.fn(sequence(fail(503), fail(503), ok()));
    const ledger = await client(fetchImpl as unknown as typeof fetch).rpcServer.getLatestLedger();

    expect(ledger.sequence).toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxAttempts and surfaces the last 5xx', async () => {
    const fetchImpl = vi.fn(sequence(fail(502)));
    await expect(client(fetchImpl as unknown as typeof fetch).rpcServer.getLatestLedger()).rejects.toThrow(/502/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 404', async () => {
    const fetchImpl = vi.fn(sequence(fail(404)));
    await expect(client(fetchImpl as unknown as typeof fetch).rpcServer.getLatestLedger()).rejects.toThrow(/404/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 501 — the endpoint is not implemented, not busy', async () => {
    const fetchImpl = vi.fn(sequence(fail(501)));
    await expect(client(fetchImpl as unknown as typeof fetch).rpcServer.getLatestLedger()).rejects.toThrow(/501/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never retries sendTransaction, even on 503', async () => {
    const fetchImpl = vi.fn(sequence(fail(503)));
    const server = client(fetchImpl as unknown as typeof fetch).rpcServer;

    const source = new Account('GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H', '0');
    const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: source.accountId(), asset: Asset.native(), amount: '1' }))
      .setTimeout(30)
      .build();

    await expect(server.sendTransaction(tx)).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a dropped connection, not just a 5xx', async () => {
    const fetchImpl = vi.fn(sequence(new Error('ECONNRESET'), ok()));
    const ledger = await client(fetchImpl as unknown as typeof fetch).rpcServer.getLatestLedger();

    expect(ledger.sequence).toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('maxAttempts: 1 disables retrying', async () => {
    setCustomFetchRetryPolicy({ maxAttempts: 1 });
    const fetchImpl = vi.fn(sequence(fail(503), ok()));

    await expect(client(fetchImpl as unknown as typeof fetch).rpcServer.getLatestLedger()).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a nonsensical policy instead of silently clamping', () => {
    expect(() => setCustomFetchRetryPolicy({ maxAttempts: 0 })).toThrow(/maxAttempts/);
    expect(() => setCustomFetchRetryPolicy({ baseDelayMs: -1 })).toThrow(/baseDelayMs/);
  });
});
