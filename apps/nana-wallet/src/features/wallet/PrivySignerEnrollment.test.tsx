import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useHeadlessDelegatedActions: vi.fn(),
}));

vi.mock("@privy-io/react-auth", () => ({
  useHeadlessDelegatedActions: mocks.useHeadlessDelegatedActions,
}));

import { PrivySignerEnrollment } from "./PrivySignerEnrollment";

describe("PrivySignerEnrollment (Solana consent via delegateWallet)", () => {
  beforeEach(() => {
    mocks.useHeadlessDelegatedActions.mockReset();
  });

  it("invokes delegateWallet with the wallet address and chainType solana, sending no signer/quorum/policy identifiers", async () => {
    const delegateWallet = vi.fn().mockResolvedValue(undefined);
    mocks.useHeadlessDelegatedActions.mockReturnValue({ delegateWallet });

    const onEnrolled = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const user = userEvent.setup();

    render(
      <PrivySignerEnrollment
        walletAddress="9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
        busy={false}
        onEnrolled={onEnrolled}
        onError={onError}
      />,
    );

    await user.click(screen.getByRole("button", { name: /autorizar firmante/i }));

    await waitFor(() => expect(delegateWallet).toHaveBeenCalledTimes(1));
    // The documented chain-aware call shape: exact args and NOTHING else —
    // the browser never supplies signer identity, quorum ids, or policy ids.
    expect(delegateWallet).toHaveBeenCalledWith({
      address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      chainType: "solana",
    });
    expect(Object.keys(delegateWallet.mock.calls[0]![0] as object).sort()).toEqual([
      "address",
      "chainType",
    ]);
    await waitFor(() => expect(onEnrolled).toHaveBeenCalledTimes(1));
    expect(onError).not.toHaveBeenCalled();
  });

  it("surfaces a delegation failure through onError and does not report enrollment", async () => {
    const delegateWallet = vi.fn().mockRejectedValue(new Error("User rejected delegation"));
    mocks.useHeadlessDelegatedActions.mockReturnValue({ delegateWallet });

    const onEnrolled = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const user = userEvent.setup();

    render(
      <PrivySignerEnrollment
        walletAddress="9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
        busy={false}
        onEnrolled={onEnrolled}
        onError={onError}
      />,
    );

    await user.click(screen.getByRole("button", { name: /autorizar firmante/i }));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith("User rejected delegation");
    expect(onEnrolled).not.toHaveBeenCalled();
  });
});
