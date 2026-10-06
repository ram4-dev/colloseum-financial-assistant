import type { EnrollmentPolicyRule } from "./enrollment-policy.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  generateAuthorizationSignature,
  type WalletApiRequestSignatureInput,
} from "@privy-io/node";

/**
 * PEW-014: real Privy server-API HTTP client (contract-exact, injectable fetch).
 *
 * This is the trusted server-side boundary for owner-verified wallet sync and
 * user-authenticated signer enrollment. It is deliberately NOT the same object as
 * the fixture/live `PrivyWalletApiClient`: every request here reaches the actual
 * Privy HTTP API with `privy-app-id` + `Authorization: Basic(base64(appId:appSecret))`.
 *
 * Security rules:
 *  - The app secret is only ever used to build the Basic header; it is never
 *    logged and never appears in a thrown `PrivyServerError` message.
 *  - The fetch implementation is injectable so contract-exact tests can assert
 *    method/url/headers without any live call.
 *  - A non-2xx response surfaces a typed `PrivyServerError` carrying the HTTP
 *    status and (when present) the provider API code — never the secret.
 */

export type PrivyFetch = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type PrivyChainType = "ethereum" | "solana";

export type PrivyServerClientConfig = {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  fetch?: PrivyFetch;
  requestTimeoutMs?: number;
  /** PKCS#8 base64 P-256 authorization private key for signed wallet mutations. */
  authorizationPrivateKey?: string;
  authorizationSigner?: (input: {
    input: WalletApiRequestSignatureInput;
    authorizationPrivateKey: string;
  }) => string | Promise<string>;
};

/** A single policy id (and optional contract shape) returned by the provider. */
export type PrivyPolicyRecord = {
  id: string;
  [key: string]: unknown;
};

/**
 * Cross-chain Privy policy rule payload. `Record<string, unknown>` keeps the
 * HTTP client agnostic: both the Ethereum `EnrollmentPolicyRule` and the
 * composed Solana `GrantPolicyRule` are structurally assignable (implicit
 * index signatures on type aliases), while each API-specific builder stays
 * responsible for its exact DSL schema.
 */
export type PrivyPolicyRule = Record<string, unknown>;

export type PrivyWalletRecord = {
  id: string;
  address: string;
  chain_type: string;
  /** Policies enforced on every authorization for this wallet. */
  policy_ids: string[];
  /** Key-quorum owner id. This is not the Privy user DID. */
  owner_id: string | null;
  /** Additional key-quorum signers attached to the wallet. */
  additional_signers: PrivyWalletSigner[];
  archived_at?: number | null;
  [key: string]: unknown;
};

export type PrivyWalletSigner = {
  signer_id: string;
  override_policy_ids?: string[];
  [key: string]: unknown;
};

export class PrivyServerError extends Error {
  public constructor(
    public readonly status: number,
    public readonly providerCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = "PrivyServerError";
  }
}

/** Extracts the documented policy override attached to an additional signer. */
function policyIdsOf(signer: PrivyWalletSigner): string[] {
  return Array.isArray(signer.override_policy_ids)
    ? signer.override_policy_ids
    : [];
}

function signerIdOf(signer: PrivyWalletSigner): string | undefined {
  return signer.signer_id;
}

function isWalletRecord(value: unknown): value is PrivyWalletRecord {
  if (!value || typeof value !== "object") return false;
  const wallet = value as Partial<PrivyWalletRecord>;
  return (
    typeof wallet.id === "string" &&
    typeof wallet.address === "string" &&
    typeof wallet.chain_type === "string" &&
    Array.isArray(wallet.policy_ids) &&
    (typeof wallet.owner_id === "string" || wallet.owner_id === null) &&
    Array.isArray(wallet.additional_signers)
  );
}

export class PrivyServerClient {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private readonly doFetch: PrivyFetch;
  private readonly requestTimeoutMs: number;
  private readonly authorizationPrivateKey?: string;
  private readonly authorizationSigner: NonNullable<
    PrivyServerClientConfig["authorizationSigner"]
  >;

  public constructor(config: PrivyServerClientConfig) {
    if (!config.appId)
      throw new Error("Privy server client requires PRIVY_APP_ID.");
    if (!config.appSecret)
      throw new Error("Privy server client requires PRIVY_APP_SECRET.");
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.baseUrl = (config.baseUrl ?? "https://api.privy.io/v1").replace(
      /\/$/u,
      "",
    );
    this.doFetch = config.fetch ?? ((url, init) => fetch(url, init));
    this.requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
    this.authorizationPrivateKey = config.authorizationPrivateKey;
    this.authorizationSigner =
      config.authorizationSigner ??
      ((input) => generateAuthorizationSignature(input));
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("Privy server client request timeout must be positive.");
    }
  }

  /** Whether this client can authorize signed wallet mutations. */
  public hasAuthorizationPrivateKey(): boolean {
    return Boolean(this.authorizationPrivateKey);
  }

  private headers(): Record<string, string> {
    const basic = Buffer.from(`${this.appId}:${this.appSecret}`).toString(
      "base64",
    );
    return {
      "privy-app-id": this.appId,
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<T | unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const init: RequestInit = {
      method,
      headers: this.headers(),
      signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    try {
      const response = await this.doFetch(url, init);
      if (!response.ok) {
        let code: string | null = null;
        try {
          const parsed = (await response.json()) as {
            error?: string;
            code?: string;
          };
          code = parsed.error ?? parsed.code ?? null;
        } catch {
          // Non-JSON error body: preserve only the status.
        }
        throw new PrivyServerError(
          response.status,
          code,
          `Privy API request failed (${response.status}).`,
        );
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async signedWalletPatch(
    walletId: string,
    body: unknown,
  ): Promise<unknown> {
    const authorizationPrivateKey = this.authorizationPrivateKey;
    if (!authorizationPrivateKey) {
      throw new PrivyServerError(
        503,
        null,
        "Privy signer policy attachment requires an authorization private key.",
      );
    }
    const url = `${this.baseUrl}/wallets/${encodeURIComponent(walletId)}`;
    const signedHeaders = {
      "privy-app-id": this.appId,
      "privy-idempotency-key": randomUUID(),
      "privy-request-expiry": String(Date.now() + 60_000),
    };
    const signature = await this.authorizationSigner({
      input: {
        version: 1,
        method: "PATCH",
        url,
        body,
        headers: signedHeaders,
      },
      authorizationPrivateKey,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.doFetch(url, {
        method: "PATCH",
        headers: {
          ...this.headers(),
          ...signedHeaders,
          "privy-authorization-signature": signature,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        let code: string | null = null;
        try {
          const parsed = (await response.json()) as {
            error?: string;
            code?: string;
          };
          code = parsed.error ?? parsed.code ?? null;
        } catch {
          // Preserve only status when the provider error is not JSON.
        }
        throw new PrivyServerError(
          response.status,
          code,
          `Privy API request failed (${response.status}).`,
        );
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Lists every active Ethereum wallet attributed to a Privy user. Ownership is
   * established by Privy's authenticated `user_id` filter; `owner_id` is a key
   * quorum id and must never be compared with the user's DID.
   */
  public async listWalletsForUser(
    privyDid: string,
  ): Promise<PrivyWalletRecord[]> {
    if (!privyDid.trim()) {
      throw new Error("Privy wallet discovery requires a user id.");
    }

    const wallets: PrivyWalletRecord[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    for (let page = 0; page < 100; page += 1) {
      const params = new URLSearchParams({
        user_id: privyDid,
        chain_type: "ethereum",
        limit: "100",
      });
      if (cursor) params.set("cursor", cursor);
      const parsed = (await this.request(
        "GET",
        `/wallets?${params.toString()}`,
      )) as { data?: unknown; next_cursor?: unknown };
      if (!Array.isArray(parsed.data) || !parsed.data.every(isWalletRecord)) {
        throw new PrivyServerError(
          502,
          null,
          "Wallet list returned an invalid response.",
        );
      }
      wallets.push(
        ...parsed.data.filter(
          (wallet) =>
            wallet.chain_type === "ethereum" && wallet.archived_at == null,
        ),
      );

      if (typeof parsed.next_cursor !== "string" || !parsed.next_cursor) break;
      if (seenCursors.has(parsed.next_cursor)) {
        throw new PrivyServerError(
          502,
          null,
          "Wallet list returned a repeated cursor.",
        );
      }
      seenCursors.add(parsed.next_cursor);
      cursor = parsed.next_cursor;
    }
    return wallets;
  }

  /** Compatibility alias retained for callers while the ownership contract is corrected. */
  public async listWalletsByOwner(
    privyDid: string,
  ): Promise<PrivyWalletRecord[]> {
    return this.listWalletsForUser(privyDid);
  }

  /**
   * List wallets for a user restricted to one chain type (e.g. "solana"),
   * using Privy's trusted user_id filter plus the chain_type query parameter.
   * Only non-archived wallets of the requested chain are returned.
   */
  public async listWalletsForChain(
    privyDid: string,
    chainType: PrivyChainType,
  ): Promise<PrivyWalletRecord[]> {
    if (!privyDid.trim()) {
      throw new Error("Privy wallet discovery requires a user id.");
    }

    const wallets: PrivyWalletRecord[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    for (let page = 0; page < 100; page += 1) {
      const params = new URLSearchParams({
        user_id: privyDid,
        chain_type: chainType,
        limit: "100",
      });
      if (cursor) params.set("cursor", cursor);
      const parsed = (await this.request(
        "GET",
        `/wallets?${params.toString()}`,
      )) as { data?: unknown; next_cursor?: unknown };
      if (!Array.isArray(parsed.data) || !parsed.data.every(isWalletRecord)) {
        throw new PrivyServerError(
          502,
          null,
          "Wallet list returned an invalid response.",
        );
      }
      wallets.push(
        ...parsed.data.filter(
          (wallet) =>
            wallet.chain_type === chainType && wallet.archived_at == null,
        ),
      );

      if (typeof parsed.next_cursor !== "string" || !parsed.next_cursor)
        return wallets;
      if (seenCursors.has(parsed.next_cursor)) {
        throw new PrivyServerError(
          502,
          null,
          "Wallet list pagination returned a repeated cursor.",
        );
      }
      seenCursors.add(parsed.next_cursor);
      cursor = parsed.next_cursor;
    }
    throw new PrivyServerError(
      502,
      null,
      "Wallet list exceeded the maximum page count.",
    );
  }

  /**
   * Returns a wallet only when it is present in Privy's trusted user-filtered
   * result. Browser-provided ids, addresses and `owner_id` are never ownership
   * evidence.
   */
  public async getVerifiedWalletForUser(
    privyDid: string,
    walletId: string,
  ): Promise<PrivyWalletRecord> {
    const wallet = (await this.listWalletsForUser(privyDid)).find(
      (candidate) => candidate.id === walletId,
    );
    if (!wallet) {
      throw new PrivyServerError(
        404,
        null,
        "Wallet was not found for the authenticated user.",
      );
    }
    return wallet;
  }

  /**
   * GET /v1/wallets/:id — single wallet readback used to prove owner + attached
   * signer policy before activation.
   */
  public async getWallet(walletId: string): Promise<PrivyWalletRecord> {
    const parsed = (await this.request(
      "GET",
      `/wallets/${encodeURIComponent(walletId)}`,
    )) as PrivyWalletRecord;
    if (!parsed || typeof parsed.id !== "string") {
      throw new PrivyServerError(
        404,
        null,
        "Wallet readback returned no wallet id.",
      );
    }
    return parsed;
  }

  /**
   * Attach one policy to the exact canonical additional signer. The wallet
   * PATCH is a complete-list mutation, so every sibling signer is copied
   * verbatim and the result is read back and compared before success.
   */
  public async addPolicyToSigner(
    walletId: string,
    signerId: string,
    policyId: string,
  ): Promise<void> {
    if (!this.authorizationPrivateKey) {
      throw new PrivyServerError(
        503,
        null,
        "Privy signer policy attachment requires an authorization private key.",
      );
    }
    const wallet = await this.getWallet(walletId);
    const matches = wallet.additional_signers.filter(
      (signer) => signer.signer_id === signerId,
    );
    if (matches.length !== 1) {
      throw new PrivyServerError(
        409,
        null,
        `Privy wallet ${walletId} has ${matches.length} additional signers matching the requested signer id.`,
      );
    }
    const currentIds = PrivyServerClient.signerPolicyIds(matches[0]!);
    if (currentIds.includes(policyId)) return;
    if (currentIds.length > 0) {
      throw new PrivyServerError(
        409,
        null,
        `Canonical signer ${signerId} already has an existing policy; refusing to overwrite it.`,
      );
    }
    const expectedSigners = wallet.additional_signers.map((signer) =>
      signer.signer_id === signerId
        ? { ...signer, override_policy_ids: [policyId] }
        : signer,
    );
    await this.signedWalletPatch(walletId, {
      additional_signers: expectedSigners,
    });
    const readback = await this.getWallet(walletId);
    if (
      readback.id !== walletId ||
      !isDeepStrictEqual(readback.additional_signers, expectedSigners)
    ) {
      throw new PrivyServerError(
        502,
        null,
        `Privy wallet ${walletId} signer policy readback did not match the complete requested signer list.`,
      );
    }
  }

  /**
   * POST /v1/policies — creates a policy named `name` holding every rule.
   * Returns { id }. `chainType` defaults to "ethereum"; pass
   * `{ chainType: "solana" }` to serialize the Solana policy chain type.
   */
  public async createPolicy(
    name: string,
    rules: PrivyPolicyRule[],
    options: { chainType?: PrivyChainType } = {},
  ): Promise<{ id: string }> {
    const parsed = (await this.request("POST", "/policies", {
      version: "1.0",
      name,
      chain_type: options.chainType ?? "ethereum",
      rules,
    })) as { id: string };
    if (!parsed?.id) {
      throw new PrivyServerError(
        500,
        null,
        "Policy creation returned no policy id.",
      );
    }
    return { id: parsed.id };
  }

  /** GET /v1/policies/:id — policy readback (complete-readback verification). */
  public async getPolicy(policyId: string): Promise<PrivyPolicyRecord> {
    const parsed = (await this.request(
      "GET",
      `/policies/${encodeURIComponent(policyId)}`,
    )) as PrivyPolicyRecord;
    if (!parsed || typeof parsed.id !== "string") {
      throw new PrivyServerError(
        404,
        null,
        "Policy readback returned no policy id.",
      );
    }
    return parsed;
  }

  /**
   * PATCH /v1/policies/:id — replaces the composed policy rules with the
   * exact given union and returns the updated record for readback.
   */
  public async patchPolicy(
    policyId: string,
    rules: PrivyPolicyRule[],
  ): Promise<PrivyPolicyRecord> {
    const parsed = (await this.request(
      "PATCH",
      `/policies/${encodeURIComponent(policyId)}`,
      { rules },
    )) as PrivyPolicyRecord;
    if (!parsed || typeof parsed.id !== "string") {
      throw new PrivyServerError(
        500,
        null,
        "Policy patch returned no policy id.",
      );
    }
    return parsed;
  }

  /** Convenience accessors for readback inspection (tolerant of casing). */
  public static signerPolicyIds(signer: PrivyWalletSigner): string[] {
    return policyIdsOf(signer);
  }

  public static signerId(signer: PrivyWalletSigner): string | undefined {
    return signerIdOf(signer);
  }
}
