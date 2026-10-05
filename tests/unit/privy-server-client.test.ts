import { describe, expect, it, vi } from "vitest";
import {
  PrivyServerClient,
  PrivyServerError,
  type PrivyFetch,
  type PrivyWalletRecord,
} from "../../src/wallet/privy-server-client.js";

const APP_ID = "client-id";
const APP_SECRET = "app-secret-value";
const BASIC = `Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString("base64")}`;
const BASE = "https://api.privy.io/v1";

function walletRecord(
  id: string,
  overrides: Partial<PrivyWalletRecord> = {},
): PrivyWalletRecord {
  return {
    id,
    address: "0x0000000000000000000000000000000000000001",
    chain_type: "ethereum",
    policy_ids: [],
    owner_id: "key-quorum-owner",
    additional_signers: [],
    archived_at: null,
    ...overrides,
  };
}

/** Builds a mock Privy response object usable by the client's fetch contract. */
function mockResponse(
  body: unknown,
  status = 200,
): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

describe("PrivyServerClient (contract-exact HTTP boundary)", () => {
  it("lists all active Ethereum wallets through Privy's trusted user_id filter", async () => {
    const fetchMock = vi.fn<PrivyFetch>(async (url) =>
      String(url).includes("cursor=page-2")
        ? mockResponse({
            data: [
              walletRecord("wallet-2"),
              walletRecord("archived", { archived_at: 123 }),
            ],
          })
        : mockResponse({
            data: [walletRecord("wallet-1")],
            next_cursor: "page-2",
          }),
    );
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      fetch: fetchMock,
    });

    const wallets = await client.listWalletsForUser("did:privy:user-1");
    expect(wallets).toHaveLength(2);
    expect(wallets[0].id).toBe("wallet-1");
    expect(wallets[1].id).toBe("wallet-2");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `${BASE}/wallets?user_id=did%3Aprivy%3Auser-1&chain_type=ethereum&limit=100`,
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `${BASE}/wallets?user_id=did%3Aprivy%3Auser-1&chain_type=ethereum&limit=100&cursor=page-2`,
    );
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers["privy-app-id"]).toBe(APP_ID);
    expect(headers.Authorization).toBe(BASIC);
  });

  it("lists active wallets for one authenticated chain", async () => {
    const fetchMock = vi.fn<PrivyFetch>(async () =>
      mockResponse({
        data: [
          walletRecord("sol-wallet", {
            address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
            chain_type: "solana",
          }),
          walletRecord("archived-sol-wallet", {
            address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
            chain_type: "solana",
            archived_at: 123,
          }),
        ],
      }),
    );
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      fetch: fetchMock,
    });

    await expect(
      client.listWalletsForChain("did:privy:user-1", "solana"),
    ).resolves.toMatchObject([{ id: "sol-wallet", chain_type: "solana" }]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${BASE}/wallets?user_id=did%3Aprivy%3Auser-1&chain_type=solana&limit=100`,
    );
  });

  it("fails closed when a chain wallet list exceeds the pagination limit", async () => {
    let page = 0;
    const fetchMock = vi.fn<PrivyFetch>(async () =>
      mockResponse({
        data: [
          walletRecord("sol-wallet", {
            address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
            chain_type: "solana",
          }),
        ],
        next_cursor: `page-${++page}`,
      }),
    );
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      fetch: fetchMock,
    });

    await expect(
      client.listWalletsForChain("did:privy:user-1", "solana"),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(100);
  });

  it("verifies ownership by exact membership in the user-filtered list", async () => {
    const fetchMock = vi.fn<PrivyFetch>(async () =>
      mockResponse({ data: [walletRecord("wallet-9")] }),
    );
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      fetch: fetchMock,
    });

    await expect(
      client.getVerifiedWalletForUser("did:privy:user-1", "wallet-9"),
    ).resolves.toMatchObject({ id: "wallet-9", owner_id: "key-quorum-owner" });
    await expect(
      client.getVerifiedWalletForUser("did:privy:user-1", "wallet-forged"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects legacy owner/signers response shapes instead of treating them as ownership evidence", async () => {
    const fetchMock = vi.fn<PrivyFetch>(async () =>
      mockResponse({
        data: [
          {
            id: "wallet-legacy",
            address: "0x0000000000000000000000000000000000000001",
            chain_type: "ethereum",
            owner: "did:privy:user-1",
            signers: [],
          },
        ],
      }),
    );
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      fetch: fetchMock,
    });

    await expect(
      client.listWalletsForUser("did:privy:user-1"),
    ).rejects.toMatchObject({
      status: 502,
    });
  });

  it("getWallet GETs /wallets/:id and returns the record", async () => {
    const fetchMock = vi.fn<PrivyFetch>(async () =>
      mockResponse({
        ...walletRecord("wallet-9", {
          address: "0x0000000000000000000000000000000000000009",
          additional_signers: [
            { signer_id: "signer-1", override_policy_ids: ["pol_abc"] },
          ],
        }),
      }),
    );
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      fetch: fetchMock,
    });

    const wallet = await client.getWallet("wallet-9");
    expect(wallet.id).toBe("wallet-9");
    expect(wallet.owner_id).toBe("key-quorum-owner");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${BASE}/wallets/wallet-9`);
    expect(init.method).toBe("GET");
  });

  it("createPolicy POSTs /policies with version/chain_type/rules and returns {id}", async () => {
    const fetchMock = vi.fn<PrivyFetch>(async () =>
      mockResponse({ id: "pol_new" }),
    );
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      fetch: fetchMock,
    });
    const rules = [
      {
        field_source: "ethereum_transaction" as const,
        field: "chain_id",
        operator: "eq",
        value: 5042002,
      },
    ];

    const { id } = await client.createPolicy("my-policy", rules);
    expect(id).toBe("pol_new");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${BASE}/policies`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["privy-app-id"]).toBe(APP_ID);
    expect(headers.Authorization).toBe(BASIC);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      version: "1.0",
      name: "my-policy",
      chain_type: "ethereum",
    });
    expect(Array.isArray(body.rules)).toBe(true);
    expect(body.rules).toHaveLength(1);
  });

  it("getPolicy GETs /policies/:id and returns the record", async () => {
    const fetchMock = vi.fn<PrivyFetch>(async () =>
      mockResponse({ id: "pol_abc", version: "1.0", rules: [] }),
    );
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      fetch: fetchMock,
    });
    const policy = await client.getPolicy("pol_abc");
    expect(policy.id).toBe("pol_abc");
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${BASE}/policies/pol_abc`);
  });

  it("surfaces a typed PrivyServerError with status + provider code but NEVER the secret", async () => {
    const fetchMock = vi.fn<PrivyFetch>(async () =>
      mockResponse(
        { error: "policy_conflict", message: "already exists" },
        409,
      ),
    );
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      fetch: fetchMock,
    });

    const error = await client.createPolicy("p", []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrivyServerError);
    const typed = error as PrivyServerError;
    expect(typed.status).toBe(409);
    expect(typed.providerCode).toBe("policy_conflict");
    expect(typed.message).not.toContain(APP_SECRET);
    expect(typed.message).not.toContain(APP_ID);
  });

  it("never throws with the secret when the constructor receives a short secret", async () => {
    const fetchMock = vi.fn<PrivyFetch>(async () => mockResponse({}, 500));
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: "short-secret",
      fetch: fetchMock,
    });
    const error = await client.getWallet("wallet-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrivyServerError);
    expect((error as PrivyServerError).message).not.toContain("short-secret");
  });

  it("bounds provider requests with an abort signal", async () => {
    const fetchMock = vi.fn<PrivyFetch>(
      async (_url, init) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      fetch: fetchMock,
      requestTimeoutMs: 5,
    });

    await expect(client.listWalletsForUser("did:privy:user-1")).rejects.toThrow(
      "aborted",
    );
    expect(fetchMock.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  });

  it("keeps the deadline active while reading the response body", async () => {
    const fetchMock = vi.fn<PrivyFetch>(async (_url, init) => ({
      ok: true,
      status: 200,
      json: async () =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("body aborted")),
          );
        }),
    }));
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      fetch: fetchMock,
      requestTimeoutMs: 5,
    });

    await expect(client.listWalletsForUser("did:privy:user-1")).rejects.toThrow(
      "body aborted",
    );
    expect(fetchMock.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  });
});

// Task 2.3 (solana-devnet-provider) — contract-exact RED tests for the Privy
// policy APIs. These describe the TARGET contract; they must fail against the
// current implementation (Ethereum-only createPolicy, no patchPolicy).
describe("PrivyServerClient task 2.3 policy contract (RED)", () => {
  const solanaRules = [
    {
      method: "signAndSendTransaction" as const,
      field_source: "solana_system_program_instruction" as const,
      field: "Transfer.to",
      operator: "in" as const,
      value: ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
    },
  ];

  function clientWith(fetchMock: PrivyFetch): PrivyServerClient {
    return new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      fetch: fetchMock,
    });
  }

  it("createPolicy serializes chain_type solana when requested", async () => {
    const fetchMock = vi.fn<PrivyFetch>(async () =>
      mockResponse({ id: "pol_sol" }),
    );
    const client = clientWith(fetchMock);

    const { id } = await client.createPolicy("sol-policy", solanaRules, {
      chainType: "solana",
    });
    expect(id).toBe("pol_sol");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${BASE}/policies`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      version: "1.0",
      name: "sol-policy",
      chain_type: "solana",
    });
    expect(body.rules).toEqual(solanaRules);
  });

  it("createPolicy keeps the ethereum default when no chainType is given", async () => {
    const fetchMock = vi.fn<PrivyFetch>(async () =>
      mockResponse({ id: "pol_eth" }),
    );
    const client = clientWith(fetchMock);

    await client.createPolicy("eth-policy", solanaRules);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.chain_type).toBe("ethereum");
  });

  it("patchPolicy sends PATCH /policies/:id with the exact rules", async () => {
    const fetchMock = vi.fn<PrivyFetch>(async () =>
      mockResponse({ id: "pol_abc", rules: solanaRules }),
    );
    const client = clientWith(fetchMock);

    await expect(
      client.patchPolicy("pol_abc", solanaRules),
    ).resolves.toMatchObject({ id: "pol_abc" });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${BASE}/policies/pol_abc`);
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.rules).toEqual(solanaRules);
  });
});

describe("PrivyServerClient canonical signer policy attachment (task 2.7)", () => {
  it("signed PATCH attaches to the exact signer, preserves siblings, and verifies readback", async () => {
    const before = walletRecord("wallet-9", {
      chain_type: "solana",
      additional_signers: [
        { signer_id: "signer-1", override_policy_ids: [], label: "target" },
        { signer_id: "sibling-1", override_policy_ids: ["sibling-policy"] },
      ],
    });
    const after = walletRecord("wallet-9", {
      chain_type: "solana",
      additional_signers: [
        {
          signer_id: "signer-1",
          override_policy_ids: ["pol_solana"],
          label: "target",
        },
        { signer_id: "sibling-1", override_policy_ids: ["sibling-policy"] },
      ],
    });
    const fetchMock = vi
      .fn<PrivyFetch>()
      .mockResolvedValueOnce(mockResponse(before))
      .mockResolvedValueOnce(mockResponse({ id: "wallet-9" }))
      .mockResolvedValueOnce(mockResponse(after));
    const authorizationSigner = vi.fn(
      ({ input, authorizationPrivateKey }: {
        input: {
          method: string;
          url: string;
          body: unknown;
          headers: Record<string, string>;
        };
        authorizationPrivateKey: string;
      }) => {
        expect(authorizationPrivateKey).toBe("test-p256-private-key");
        expect(input.method).toBe("PATCH");
        expect(input.url).toBe(`${BASE}/wallets/wallet-9`);
        return "signed-request";
      },
    );
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      authorizationPrivateKey: "test-p256-private-key",
      authorizationSigner,
      fetch: fetchMock,
    });

    await client.addPolicyToSigner("wallet-9", "signer-1", "pol_solana");

    expect(authorizationSigner).toHaveBeenCalledTimes(1);
    const [, patch] = fetchMock.mock.calls[1] ?? [];
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `${BASE}/wallets/wallet-9`,
    );
    expect(patch.method).toBe("PATCH");
    const headers = patch.headers as Record<string, string>;
    expect(headers["privy-authorization-signature"]).toBe("signed-request");
    const body = JSON.parse(String(patch.body)) as {
      additional_signers: unknown[];
    };
    expect(body.additional_signers).toEqual(after.additional_signers);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refuses to overwrite another policy already attached to the canonical signer", async () => {
    const fetchMock = vi.fn<PrivyFetch>(async () =>
      mockResponse(
        walletRecord("wallet-9", {
          additional_signers: [
            { signer_id: "signer-1", override_policy_ids: ["other-policy"] },
          ],
        }),
      ),
    );
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      authorizationPrivateKey: "test-p256-private-key",
      authorizationSigner: () => "signed-request",
      fetch: fetchMock,
    });

    await expect(
      client.addPolicyToSigner("wallet-9", "signer-1", "pol_solana"),
    ).rejects.toThrow(/existing policy/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
