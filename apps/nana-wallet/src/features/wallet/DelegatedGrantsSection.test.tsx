import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DelegatedGrant } from "@/lib/api-types";

const mocks = vi.hoisted(() => ({
  createGrant: vi.fn(),
  listGrants: vi.fn(),
  revokeGrant: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    createGrant: (...args: unknown[]) => mocks.createGrant(...args),
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
    mocks.createGrant.mockResolvedValue({ grant: activeGrant({ policyReady: false }) });
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
    mocks.listGrants.mockResolvedValue({
      grants: [activeGrant({ maxPerTransfer: "10000000", maxCumulative: "50000000" })],
    });
    render(
      <Wrapper>
        <DelegatedGrantsSection userId={USER_ID} />
      </Wrapper>,
    );
    expect(await screen.findByText("Activa")).toBeTruthy();
    // Solana grant limits are persisted as lamports and shown as SOL.
    expect(screen.getByText(/0\.01/, { selector: "dd" })).toHaveTextContent("0.01 SOL");
    expect(screen.getByText(/0\.05/, { selector: "dd" })).toHaveTextContent("0.05 SOL");
    expect(screen.getByText("Tope máximo por transferencia: 0.01 SOL.")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Revocar autorización/i }));
    await waitFor(() => expect(mocks.revokeGrant).toHaveBeenCalledWith(GRANT_ID));
  });

  it("creates an explicit bounded grant for the current wallet", async () => {
    render(
      <Wrapper>
        <DelegatedGrantsSection userId={USER_ID} />
      </Wrapper>,
    );
    await screen.findByText(/Todavía no tenés autorizaciones delegadas/i);
    await userEvent.click(screen.getByText("Crear autorización", { selector: "summary" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Direcciones autorizadas" }),
      "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    );
    await userEvent.click(screen.getByRole("button", { name: "Crear autorización" }));
    await waitFor(() => expect(mocks.createGrant).toHaveBeenCalledOnce());
    expect(mocks.createGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "transfer",
        chain: "solana",
        maxPerTransfer: "10000000",
        maxCumulative: "50000000",
        windowSeconds: 86_400,
        recipients: ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
        expiresAt: expect.any(String),
      }),
    );
    expect(await screen.findByText(/pendiente: el proveedor todavía no permite/i)).toBeTruthy();
  });

  it("shows the fixed 0.01 SOL ceiling and rejects a larger transfer amount", async () => {
    render(
      <Wrapper>
        <DelegatedGrantsSection userId={USER_ID} />
      </Wrapper>,
    );
    await screen.findByText(/Todavía no tenés autorizaciones delegadas/i);
    await userEvent.click(screen.getByText("Crear autorización", { selector: "summary" }));
    expect(screen.getByText(/Tope por transferencia: 0\.01 SOL/i)).toBeTruthy();
    await userEvent.clear(screen.getByRole("textbox", { name: "Máximo por transferencia" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Máximo por transferencia" }),
      "0.010000001",
    );
    await userEvent.clear(screen.getByRole("textbox", { name: "Máximo acumulado por día" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Máximo acumulado por día" }), "0.02");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Direcciones autorizadas" }),
      "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    );
    await userEvent.click(screen.getByRole("button", { name: "Crear autorización" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/0\.01 SOL/i);
    expect(mocks.createGrant).not.toHaveBeenCalled();
  });

  it("converts decimal SOL to exact lamports without floating-point rounding", async () => {
    render(
      <Wrapper>
        <DelegatedGrantsSection userId={USER_ID} />
      </Wrapper>,
    );
    await screen.findByText(/Todavía no tenés autorizaciones delegadas/i);
    await userEvent.click(screen.getByText("Crear autorización", { selector: "summary" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Máximo por transferencia" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Máximo por transferencia" }),
      "0.000000001",
    );
    await userEvent.clear(screen.getByRole("textbox", { name: "Máximo acumulado por día" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Máximo acumulado por día" }),
      "0.000000002",
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Direcciones autorizadas" }),
      "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    );
    await userEvent.click(screen.getByRole("button", { name: "Crear autorización" }));
    await waitFor(() => expect(mocks.createGrant).toHaveBeenCalledOnce());
    expect(mocks.createGrant).toHaveBeenCalledWith(
      expect.objectContaining({ maxPerTransfer: "1", maxCumulative: "2" }),
    );
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

  it("does not present a grant as active until provider policy is ready", async () => {
    mocks.listGrants.mockResolvedValue({
      grants: [activeGrant({ policyReady: false })],
    });
    render(
      <Wrapper>
        <DelegatedGrantsSection userId={USER_ID} />
      </Wrapper>,
    );
    expect(await screen.findByText("Pendiente de habilitación")).toBeTruthy();
    expect(screen.queryByText("Activa")).toBeNull();
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
