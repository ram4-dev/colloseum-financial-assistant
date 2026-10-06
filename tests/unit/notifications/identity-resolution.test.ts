import { describe, expect, it, vi } from "vitest";

import {
  resolveWebhookWalletIdentity,
  type WebhookWalletIdentityDependencies,
} from "../../../src/notifications/identity-resolution.js";

const WALLET_ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const PRIVY_ACCOUNT_ID = "privy-account-abc123";
const OWNER_ID = "0b7f8c1e-0000-4000-8000-000000000003";

function dependencies(
  overrides: Partial<WebhookWalletIdentityDependencies> = {},
): WebhookWalletIdentityDependencies {
  return {
    findEnrolledWallet: vi.fn(async (address: string) =>
      address === WALLET_ADDRESS
        ? { walletId: "wallet-1", userId: OWNER_ID, network: "solana-devnet" }
        : null,
    ),
    ...overrides,
  };
}

describe("webhook wallet identity resolution (server-owned ownership)", () => {
  it("resolves a verified Privy wallet/account ID to the locally enrolled wallet owner", async () => {
    const deps = dependencies();
    const identity = await resolveWebhookWalletIdentity(
      { privyAccountId: PRIVY_ACCOUNT_ID, walletAddress: WALLET_ADDRESS },
      deps,
    );
    expect(identity).not.toBeNull();
    expect(identity).toMatchObject({
      walletId: "wallet-1",
      userId: OWNER_ID,
      network: "solana-devnet",
    });
    expect(deps.findEnrolledWallet).toHaveBeenCalledWith(WALLET_ADDRESS);
  });

  it("ignores payload-supplied user IDs when resolving ownership", async () => {
    const deps = dependencies();
    const identity = await resolveWebhookWalletIdentity(
      {
        privyAccountId: PRIVY_ACCOUNT_ID,
        walletAddress: WALLET_ADDRESS,
        // Attacker-controlled payload claims a different owner.
        payloadUserId: "0b7f8c1e-0000-4000-8000-000000000099",
      },
      deps,
    );
    expect(identity).not.toBeNull();
    expect(identity!.userId).toBe(OWNER_ID);
  });

  it("rejects an unenrolled wallet address without owner fallback", async () => {
    const deps = dependencies();
    const identity = await resolveWebhookWalletIdentity(
      {
        privyAccountId: PRIVY_ACCOUNT_ID,
        walletAddress: "unknown-wallet-address",
        payloadUserId: OWNER_ID,
      },
      deps,
    );
    expect(identity).toBeNull();
  });

  it("requires the verified account ID to match the enrolled wallet binding", async () => {
    const deps = dependencies({
      findEnrolledWallet: vi.fn(async (address: string) =>
        address === WALLET_ADDRESS
          ? {
              walletId: "wallet-1",
              userId: OWNER_ID,
              network: "solana-devnet",
              privyAccountId: "privy-account-OTHER",
            }
          : null,
      ),
    });
    const identity = await resolveWebhookWalletIdentity(
      { privyAccountId: PRIVY_ACCOUNT_ID, walletAddress: WALLET_ADDRESS },
      deps,
    );
    // A different Privy account for the same address must not resolve.
    expect(identity).toBeNull();
  });
});
