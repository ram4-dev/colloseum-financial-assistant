import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../src/db/client.js";
import {
  DelegatedGrantService,
  InvalidGrantInputError,
} from "../../src/wallet/grants/consumption.js";

describe("Solana delegated grant ceiling", () => {
  it("rejects a direct service call above 10,000,000 lamports before opening a transaction", async () => {
    const withUserTransaction = vi.fn();
    const database = { withUserTransaction } as unknown as DatabaseClient;
    const service = new DelegatedGrantService(database);

    await expect(
      service.createGrant({
        userId: "user-1",
        walletId: "wallet-1",
        action: "transfer",
        chain: "solana",
        maxPerTransfer: "10000001",
        maxCumulative: "20000000",
        windowSeconds: 86_400,
        recipients: ["recipient"],
        expiresAt: new Date("2026-10-10T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(InvalidGrantInputError);
    expect(withUserTransaction).not.toHaveBeenCalled();
  });
});
