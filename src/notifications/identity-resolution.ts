export type EnrolledWalletRecord = {
  walletId: string;
  userId: string;
  network: string;
  privyAccountId?: string;
};

export type WebhookWalletIdentityDependencies = {
  findEnrolledWallet: (
    walletAddress: string,
  ) => Promise<EnrolledWalletRecord | null>;
};

export type WebhookIdentityInput = {
  privyAccountId: string;
  walletAddress: string;
  /** Never trusted for ownership; present in some provider payloads. */
  payloadUserId?: string;
};

export type ResolvedWebhookIdentity = {
  walletId: string;
  userId: string;
  network: string;
};

/**
 * Resolve a verified provider wallet/account identity to the locally enrolled
 * wallet and owner. Ownership comes exclusively from the local enrollment
 * record: payload-supplied user IDs are ignored, unenrolled addresses never
 * resolve, and a verified Privy account ID that does not match the wallet's
 * binding is rejected.
 */
export async function resolveWebhookWalletIdentity(
  input: WebhookIdentityInput,
  dependencies: WebhookWalletIdentityDependencies,
): Promise<ResolvedWebhookIdentity | null> {
  const enrolled = await dependencies.findEnrolledWallet(input.walletAddress);
  if (!enrolled) return null;

  // When the enrollment carries an account binding, the verified account ID
  // must match it; a different Privy account for the same address is rejected.
  if (
    enrolled.privyAccountId !== undefined &&
    enrolled.privyAccountId !== input.privyAccountId
  ) {
    return null;
  }

  return {
    walletId: enrolled.walletId,
    userId: enrolled.userId,
    network: enrolled.network,
  };
}
