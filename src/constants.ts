import { Networks } from '@stellar/stellar-sdk';

/** Stellar networks supported by public explorer links. */
export type NetworkType = 'mainnet' | 'testnet' | 'futurenet';

/** Human-readable labels for Stellar networks. */
export const NETWORK_NAMES: Record<NetworkType, string> = {
  mainnet: 'Mainnet',
  testnet: 'Testnet',
  futurenet: 'Futurenet',
};

/**
 * Stellar Expert URL bases, keyed by network and resource type.
 * Append the transaction hash, contract ID, or account ID to the relevant
 * base URL instead of rebuilding explorer paths throughout an application.
 */
export const EXPLORER_URLS: Record<
  NetworkType,
  { transaction: string; contract: string; account: string }
> = {
  mainnet: {
    transaction: 'https://stellar.expert/explorer/public/tx/',
    contract: 'https://stellar.expert/explorer/public/contract/',
    account: 'https://stellar.expert/explorer/public/account/',
  },
  testnet: {
    transaction: 'https://stellar.expert/explorer/testnet/tx/',
    contract: 'https://stellar.expert/explorer/testnet/contract/',
    account: 'https://stellar.expert/explorer/testnet/account/',
  },
  futurenet: {
    transaction: 'https://stellar.expert/explorer/futurenet/tx/',
    contract: 'https://stellar.expert/explorer/futurenet/contract/',
    account: 'https://stellar.expert/explorer/futurenet/account/',
  },
};

/**
 * Networks the SDK can be configured against.
 *
 * `futurenet` and `standalone` are listed here because both are used for
 * day-to-day development: futurenet mirrors the protocol upgrade before it
 * reaches testnet, and standalone is the throwaway network `stellar
 * contract deploy --network local` produces (#981).
 */
export type NetworkKey = 'mainnet' | 'testnet' | 'futurenet' | 'standalone';

/** Contract roles a StreamFi deployment consists of. */
export interface NetworkContracts {
  factory: string | null;
  governor: string | null;
}

/** Everything needed to talk to one Stellar network. */
export interface NetworkConfig {
  /** Soroban RPC endpoint. */
  rpcUrl: string;
  /** Passphrase that identifies the network when signing. */
  networkPassphrase: string;
  /**
   * Stellar Expert bases for explorer links, or `null` where no public
   * explorer tracks the network (standalone runs on your own machine).
   */
  explorer: { transaction: string; contract: string; account: string } | null;
  /**
   * Published contract IDs, or `null` per role where none is published.
   *
   * StreamFi has no canonical deployment on futurenet or standalone — those
   * IDs are generated at deploy time from the deployer address and salt, so
   * hardcoding one would point at somebody else's contract. Read them from
   * your deployment output and pass them to the client explicitly.
   */
  contracts: NetworkContracts;
}

/**
 * Per-network configuration: RPC endpoint, passphrase, explorer bases and
 * published contract IDs.
 *
 * @example
 * ```ts
 * import { NETWORK_CONFIG } from './constants.js';
 * const { rpcUrl, networkPassphrase } = NETWORK_CONFIG.standalone;
 * ```
 */
export const NETWORK_CONFIG: Record<NetworkKey, NetworkConfig> = {
  mainnet: {
    rpcUrl: 'https://soroban-mainnet.stellar.org',
    networkPassphrase: Networks.PUBLIC,
    explorer: EXPLORER_URLS.mainnet,
    contracts: { factory: null, governor: null },
  },
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
    explorer: EXPLORER_URLS.testnet,
    contracts: { factory: null, governor: null },
  },
  futurenet: {
    rpcUrl: 'https://soroban-futurenet.stellar.org',
    networkPassphrase: Networks.FUTURENET,
    explorer: EXPLORER_URLS.futurenet,
    contracts: { factory: null, governor: null },
  },
  standalone: {
    // `stellar container start local` exposes Soroban RPC on this port.
    rpcUrl: 'http://localhost:8000/soroban/rpc',
    networkPassphrase: Networks.STANDALONE,
    explorer: null,
    contracts: { factory: null, governor: null },
  },
};

/**
 * Read a published contract ID for `network`.
 *
 * Throws when no ID is published instead of returning an empty string that
 * would fail later inside a transaction with an opaque error. Pass the address
 * you deployed yourself when that happens.
 */
export function contractIdFor(network: NetworkKey, role: keyof NetworkContracts): string {
  const id = NETWORK_CONFIG[network].contracts[role];
  if (!id) {
    throw new Error(
      `No canonical ${role} contract ID is published for the '${network}' network — ` +
        'StreamFi contract IDs are generated per deployment. Deploy the contracts and ' +
        `pass the ${role} address explicitly, e.g. new ConduitClient({ network: '${network}', ` +
        `factoryAddress: '<your ${role} contract ID>' }).`,
    );
  }
  return id;
}

/**
 * A syntactically valid Stellar G-address with no known keypair. Used only
 * as the transaction source for read-only simulation calls when no real
 * keypair is configured — Soroban's simulateTransaction doesn't require the
 * source account to actually exist or sign anything for a read-only
 * invocation. Never used to sign or move funds.
 */
export const ZERO_ADDR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Minimum stream duration (in seconds). Streams cannot be created with duration less than this. */
export const MIN_STREAM_DURATION_SECONDS = 3600;

/** Default page size for `ProductionModule` / `StreamsModule.list()` pagination. */
export const DEFAULT_LIST_LIMIT = 20;

/**
 * Maximum page size the SDK will send to `DripFactory::streams_by_sender` /
 * `streams_by_recipient`. The contract itself does not clamp this — an
 * unbounded `limit` produces an oversized simulation response -- so the SDK
 * enforces the README-documented max client-side (see #489).
 */
export const MAX_LIST_LIMIT = 100;

/**
 * Clamp a caller-supplied list `limit` into the valid `[1, MAX_LIST_LIMITY`
 * range expected by `streams_by_sender` / `streams_by_recipient`. Non-finite
 * input (NaN, ±Infinity) and values that truncate to `0` or below fall back
 * to {@link DEFAULT_LIST_LIMIT} rather than producing an invalid u32
 * conversion or an empty page.
 */
export function clampListLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  const truncated = Math.trunc(limit);
  if (truncated <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(truncated, MAX_LIST_LIMIT);
}

/**
 * Clamp a caller-supplied pagination `offset` to a non-negative integer
 * within the valid u32 range (`[0, 2^32 - 1]`). Non-finite or negative
 * input returns 0 rather than producing an invalid u32 conversion.
 */
export function clampOffset(offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.min(Math.max(Math.trunc(offset), 0), 0xFFFFFFFF);
}

/**
 * Bit-flags packed into the on-chain `StreamInfo.flags` (`u32`). `paused`,
 * `cancelled` and `clawback_enabled` are NOT individual struct fields -- they
 * live in these bits.
 *
 * Mirrors `FLAG_PAUSED` / `FLAG_CLAWBACK_ENABLED` and the
 * `StreamInfo::is_paused()` / `is_cancelled()` / `is_clawback_enabled()`
 * getters in `contracts/stream/src/storage.rs`.
 */
export const STREAM_FLAG_PAUSED = 1;
export const STREAM_FLAG_CLAWBACK_ENABLED = 1 << 1;
export const STREAM_FLAG_CANCELLED = 1 << 2;

/**
 * Known USDC issuer G-addresses per network.
 *
 * - `mainnet` — Circle's production issuer.
 * - `testnet` — Circle's Testnet issuer (SDF Test Network).
 * - `local`   — No canonical USDC issuer exists on a local Soroban instance.
 *   Accessing this entry throws at runtime so callers get a clear error
 *   instead of silently inheriting the mainnet address (see #804).
 *
 * @example
 * ```ts
 * import { USDC_ISSUER } from './constants.js';
 * const issuer = USDC_ISSUER[network]; // throws on 'local'
 * ```
 */
export const USDC_ISSUER: Record<'mainnet' | 'testnet', string> & {
  readonly local: never;
} = {
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  get local(): never {
    throw new Error(
      "token: 'USDC' is not supported on the 'local' network — no canonical " +
      'USDC issuer exists on a local Soroban instance. ' +
      'Pass an explicit contract address for your locally-deployed token instead.',
    );
  },
} as const;
