import { describe, expect, it, vi } from "vitest";
import { createConfiguredWalletForUser } from "../../src/runtime/dependencies.js";
import type { DatabaseClient } from "../../src/db/client.js";
import { PrivyServerClient } from "../../src/wallet/privy-server-client.js";

describe("configured multi-chain per-user wallet resolver", () => {
  it("requires an explicit chain family instead of falling through to Ethereum", async () => {
    const privy = new PrivyServerClient({
      appId: "app-test",
      appSecret: "secret-test",
      fetch: vi.fn(),
    });
    const resolve = createConfiguredWalletForUser(
      {} as DatabaseClient,
      { IDENTITY_PROVIDER: "privy" },
      privy,
    );

    await expect(resolve?.("user-a")).rejects.toMatchObject({
      code: "wallet_config_error",
    });
  });
});
