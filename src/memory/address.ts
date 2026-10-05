import { PublicKey } from "@solana/web3.js";

/** EVM records remain the implicit legacy default; Solana is explicit devnet only. */
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export function isValidEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value.trim());
}

export function isValidSolanaAddress(value: string): boolean {
  try {
    const trimmed = value.trim();
    const key = new PublicKey(trimmed);
    return key.toBytes().length === 32 && key.toBase58() === trimmed;
  } catch {
    return false;
  }
}

export function isValidRecipientAddress(value: string, network?: string | null): boolean {
  if (network === "solana-devnet") return isValidSolanaAddress(value);
  // EVM recipient syntax is chain-independent (Arc, Sepolia, mainnet, etc.);
  // transfer policy separately binds the request to its configured network.
  return isValidEvmAddress(value);
}
