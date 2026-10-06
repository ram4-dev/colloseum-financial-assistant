import { describe, expect, it } from "vitest";
import { isValidRecipientAddress } from "../../../src/memory/address.js";

describe("chain-scoped recipient address validation", () => {
  const evmAddress = "0x1111111111111111111111111111111111111111";
  const solanaAddress = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  it("keeps legacy contacts without a network on the EVM validation path", () => {
    expect(isValidRecipientAddress(evmAddress)).toBe(true);
    expect(isValidRecipientAddress(evmAddress, undefined)).toBe(true);
  });

  it("accepts canonical Solana recipient addresses only for solana-devnet", () => {
    expect(isValidRecipientAddress(solanaAddress, "solana-devnet")).toBe(true);
    expect(isValidRecipientAddress(solanaAddress)).toBe(false);
    expect(isValidRecipientAddress(evmAddress, "solana-devnet")).toBe(false);
  });

  it("rejects malformed addresses for either chain", () => {
    expect(isValidRecipientAddress("not-an-address", "solana-devnet")).toBe(false);
    expect(isValidRecipientAddress("0x1234")).toBe(false);
  });
});
