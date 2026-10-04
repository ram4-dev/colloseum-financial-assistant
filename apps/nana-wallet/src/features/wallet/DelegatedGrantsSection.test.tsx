import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DelegatedGrant } from "@/lib/api-types";

const mocks = vi.hoisted(() => ({
  listGrants: vi.fn(),
  revokeGrant: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    listGrants: (...args: unknown[]) => mocks.listGrants(...args),
    revokeGrant: (...args: unknown[]) => mocks.revokeGrant(...args),
  },
  queryKeys: {
    grants: (userId: string | undefined) => ["grants", userId],
  },
}));

import { DelegatedGrantsSection } from "./DelegatedGrantsSection";

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const USER_ID = "user-1";
const GRANT_ID = "grant-1";

function activeGrant(overrides: Partial<DelegatedGrant> = {}): DelegatedGrant {
  return {
    id: GRANT_ID,
    walletId: "wallet-1",
    action: "transfer",
    chain: "solana",
    maxPerTransfer: "1000000",
    maxCumulative: "5000000",
    windowSeconds: 3600,
    recipients: ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
    state: "active",
    policyReady: true,
    createdAt: "2026-10-03T22:00:00.000Z",
    expiresAt: "2026-10-10T22:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

describe("DelegatedGrantsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listGrants.mockResolvedValue({ grants: [] });
    mocks.revokeGrant.mockResolvedValue({ grant: activeGrant({ state: "revoked" }) });
  });

  it("explains the delegation model when there are no grants", async () => {
    render(
      <Wrapper>
        <DelegatedGrantsSection userId={USER_ID} />
      </Wrapper>,
    );
    expect(await screen.findByText(/Todavía no tenés autorizaciones delegadas/i)).toBeTruthy();
    expect(screen.getByText(/confirmación explícita/i)).toBeTruthy();
  });

  it("shows an active grant with its limits and allows revoking it", async () => {
    mocks.listGrants.mockResolvedValue({ grants: [activeGrant()] });
    render(
      <Wrapper>
        <DelegatedGrantsSection userId={USER_ID} />
      </Wrapper>,
    );
    expect(await screen.findByText("Activa")).toBeTruthy();
    // Limits render locale-formatted by formatLimit.
    expect(screen.getByText(/1\.000\.000|1000000/)).toBeTruthy();
    expect(screen.getByText(/5\.000\.000|5000000/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Revocar autorización/i }));
    await waitFor(() => expect(mocks.revokeGrant).toHaveBeenCalledWith(GRANT_ID));
  });

  it("shows the revoked state without a revoke action", async () => {
    mocks.listGrants.mockResolvedValue({
      grants: [activeGrant({ state: "revoked", revokedAt: "2026-10-04T00:00:00.000Z" })],
    });
    render(
      <Wrapper>
        <DelegatedGrantsSection userId={USER_ID} />
      </Wrapper>,
    );
    expect(await screen.findByText("Revocada")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Revocar autorización/i })).toBeNull();
  });

  it("surfaces a readable error when revocation fails", async () => {
    mocks.listGrants.mockResolvedValue({ grants: [activeGrant()] });
    mocks.revokeGrant.mockRejectedValue(new Error("boom"));
    render(
      <Wrapper>
        <DelegatedGrantsSection userId={USER_ID} />
      </Wrapper>,
    );
    await screen.findByText("Activa");
    await userEvent.click(screen.getByRole("button", { name: /Revocar autorización/i }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
