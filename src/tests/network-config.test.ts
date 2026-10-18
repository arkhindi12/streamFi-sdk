import { describe, it, expect, afterEach } from 'vitest';
import { Networks, StrKey } from '@stellar/stellar-sdk';
import { NETWORK_CONFIG, EXPLORER_URLS, contractIdFor, type NetworkKey } from '../constants.js';

const NETWORKS: NetworkKey[] = ['mainnet', 'testnet', 'futurenet', 'standalone'];

describe('NETWORK_CONFIG (#981)', () => {
  it('describes all four networks the SDK can target', () => {
    expect(Object.keys(NETWORK_CONFIG).sort()).toEqual([...NETWORKS].sort());
    for (const key of NETWORKS) {
      const cfg = NETWORK_CONFIG[key];
      expect(cfg.rpcUrl).toMatch(/^https?:\/\//);
      expect(cfg.networkPassphrase.length).toBeGreaterThan(0);
      expect(cfg.contracts).toHaveProperty('factory');
      expect(cfg.contracts).toHaveProperty('governor');
    }
  });

  it('uses the passphrases the Stellar SDK signs with', () => {
    expect(NETWORK_CONFIG.mainnet.networkPassphrase).toBe(Networks.PUBLIC);
    expect(NETWORK_CONFIG.testnet.networkPassphrase).toBe(Networks.TESTNET);
    expect(NETWORK_CONFIG.futurenet.networkPassphrase).toBe(Networks.FUTURENET);
    expect(NETWORK_CONFIG.standalone.networkPassphrase).toBe(Networks.STANDALONE);
  });

  it('points futurenet and standalone at their own RPC endpoints', () => {
    expect(NETWORK_CONFIG.futurenet.rpcUrl).toContain('futurenet');
    // A standalone container serves RPC on the local port, not the internet.
    expect(NETWORK_CONFIG.standalone.rpcUrl).toBe('http://localhost:8000/soroban/rpc');
  });

  it('reuses the explorer bases instead of duplicating them', () => {
    expect(NETWORK_CONFIG.mainnet.explorer).toEqual(EXPLORER_URLS.mainnet);
    expect(NETWORK_CONFIG.testnet.explorer).toEqual(EXPLORER_URLS.testnet);
    expect(NETWORK_CONFIG.futurenet.explorer).toEqual(EXPLORER_URLS.futurenet);
    // No public explorer follows a network that only exists on your machine.
    expect(NETWORK_CONFIG.standalone.explorer).toBeNull();
  });

  it('does not invent contract IDs that were never deployed', () => {
    for (const key of NETWORKS) {
      expect(NETWORK_CONFIG[key].contracts.factory).toBeNull();
      expect(NETWORK_CONFIG[key].contracts.governor).toBeNull();
    }
  });

  it('throws a message that tells you what to do when no ID is published', () => {
    expect(() => contractIdFor('futurenet', 'factory')).toThrow(/No canonical factory contract ID/);
    expect(() => contractIdFor('futurenet', 'factory')).toThrow(/pass the factory address explicitly/);
  });

  describe('when a deployment publishes an ID', () => {
    const contracts = NETWORK_CONFIG.standalone.contracts;

    afterEach(() => {
      contracts.factory = null;
    });

    it('returns it', () => {
      const deployed = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';
      contracts.factory = deployed;

      expect(contractIdFor('standalone', 'factory')).toBe(deployed);
      expect(StrKey.isValidContract(contractIdFor('standalone', 'factory'))).toBe(true);
    });
  });
});
