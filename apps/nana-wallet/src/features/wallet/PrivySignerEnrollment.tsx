import { Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useHeadlessDelegatedActions } from "@privy-io/react-auth";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/**
 * Solana consent enrollment (task 2.7): the user-authenticated half of Solana
 * signer enrollment. Rendered ONLY inside the Privy tree (privy mode) and
 * lazy-loaded so bundles outside PrivyProvider never import it.
 *
 * Consent goes through Privy's chain-aware `delegateWallet` action with the
 * wallet address and `chainType: 'solana'`. The browser supplies NO signer
 * identity, quorum ids, or policy ids: Privy provisions the new signer server
 * side and the backend `complete` read-back is what proves the exact signer +
 * policy binding before persisting the canonical id.
 */
export function PrivySignerEnrollment({
  walletAddress,
  busy,
  onEnrolled,
  onError,
}: {
  walletAddress: string;
  busy: boolean;
  onEnrolled: () => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const { delegateWallet } = useHeadlessDelegatedActions();
  const [consenting, setConsenting] = useState(false);

  async function handleConsent() {
    setConsenting(true);
    try {
      await delegateWallet({ address: walletAddress, chainType: "solana" });
      toast.success("Confirmaste la autorización en Privy.");
      await onEnrolled();
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "No pudimos confirmar la autorización con Privy.",
      );
    } finally {
      setConsenting(false);
    }
  }

  return (
    <Button
      type="button"
      className="press mt-4 min-h-14 w-full text-base font-extrabold"
      onClick={() => void handleConsent()}
      disabled={busy || consenting}
    >
      {busy || consenting ? (
        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
      ) : (
        <ShieldCheck className="size-5" aria-hidden="true" />
      )}
      Autorizar firmante en Privy
    </Button>
  );
}
