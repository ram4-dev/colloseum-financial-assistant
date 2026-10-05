import { describe, expect, it, vi } from "vitest";
import { bindLiveKitWalletForUser } from "../../../src/livekit/worker.js";
import { FixtureWalletProvider } from "../../../src/wallet/fixture-provider.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";

describe("LiveKit wallet chain binding", () => {
  it("binds the financial session to the ledger family selected by its network", async () => {
    const provider = new FixtureWalletProvider();
    const resolve = vi.fn(async () => provider);
    const wallet = bindLiveKitWalletForUser(resolve, USER_ID, "solana-devnet");

    await wallet.listNetworks();

    expect(resolve).toHaveBeenCalledWith(USER_ID, "solana");
  });

  it("fails closed when a LiveKit session has an unsupported network", async () => {
    const resolve = vi.fn(async () => new FixtureWalletProvider());
    const wallet = bindLiveKitWalletForUser(resolve, USER_ID, "unknown-net");

    await expect(wallet.listNetworks()).rejects.toMatchObject({
      code: "wallet_config_error",
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});
