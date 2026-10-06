import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWalletConversationService } from "../../src/conversations/service.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";
import type { ConversationRepository } from "../../src/conversations/repository.js";

/**
 * Phase 5 (slice3-grant-execution): model-origin / realtime-tool exclusion —
 * E2E fixture level.
 *
 * Binding contract: a model-produced realtime `send_token` preview NEVER
 * claims a grant and NEVER broadcasts directly. Tool previews keep the
 * existing explicit-confirm flow: `confirm_transfer` (a user action) is the
 * only broadcast route. The grant gate is consulted exclusively on the
 * original authenticated turn/transcript path inside the service.
 */

const userId = "11111111-1111-4111-8111-111111111111";
const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const recipient = "0x1234567890123456789012345678901234567890";

function repositoryFixture(): ConversationRepository {
  let snapshot: any = {
    id: conversationId,
    userId,
    mode: "typed",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    revision: 0,
    language: "es",
    generation: 1,
    messages: [],
  };
  const attempts: Array<{ id: string; status: string }> = [];
  const repository = {
    async create() {
      return snapshot;
    },
    async get() {
      return { ...snapshot, messages: [...snapshot.messages] };
    },
    async inspect() {
      return { ...snapshot, messages: [...snapshot.messages] };
    },
    async appendMessage(_u: string, _c: string, m: any) {
      snapshot.messages.push(m);
    },
    async saveSnapshot(_u: string, incoming: any) {
      // Durable semantics: a NEW pendingTransfer creates an attempt row and
      // attaches the durable id as previewId (PostgresConversationRepository).
      let pending = incoming.pendingTransfer;
      if (pending && !pending.previewId) {
        const id = randomUUID();
        attempts.push({ id, status: "previewed" });
        pending = { ...pending, previewId: id };
      }
      snapshot = {
        ...incoming,
        ...(pending ? { pendingTransfer: pending } : {}),
        revision: incoming.revision + 1,
      };
      return snapshot;
    },
    async updateState(_u: string, _c: string, _r: number, st: any) {
      snapshot = { ...snapshot, ...st };
      return snapshot.revision + 1;
    },
    async setProgress() {
      return snapshot.revision + 1;
    },
    async setPendingTransfer() {
      return snapshot.revision + 1;
    },
    async clearPendingTransfer() {
      snapshot = { ...snapshot, pendingTransfer: undefined };
      return snapshot;
    },
    async cancelPendingTransfer() {
      return "cancelled" as const;
    },
    async claimPendingTransfer() {
      const pending = attempts.find((a) => a.status === "previewed");
      if (!pending) return { status: "missing" as const };
      pending.status = "broadcasting";
      if (!snapshot.pendingTransfer) return { status: "missing" as const };
      return {
        status: "claimed" as const,
        transfer: { ...snapshot.pendingTransfer, previewId: pending.id },
      };
    },
    async releasePendingTransferClaim() {},
    async markPendingTransferUncertain() {},
    async setLastTransactionHash() {},
    async markTransferSubmitted() {},
    async finalizeTransfer() {
      snapshot = { ...snapshot, pendingTransfer: undefined };
    },
    async setMode() {
      return snapshot.revision + 1;
    },
    async acquireLiveLease() {
      throw new Error("not used");
    },
    async renewLiveLease() {
      return false;
    },
    async releaseLiveLease() {
      return false;
    },
  };
  return repository as unknown as ConversationRepository;
}

describe("grant gate model-origin exclusion (phase 5 E2E fixture)", () => {
  it("model tool preview (persistNativePreview dry-run) never consults the gate nor broadcasts", async () => {
    const wallet = new FixtureWalletProvider();
    const broadcast = vi.spyOn(wallet, "broadcastTransfer");
    const ledgerClaim = vi.fn(async () => ({ consumed: true }));
    const gateEvaluate = vi.fn(async () => ({
      covered: true,
      source: "delegated_grant" as const,
      grantId: "g-1",
      amountSmallestUnits: "10000000",
      orderedCandidates: [{ grantId: "g-1", amountSmallestUnits: "10000000" }],
    }));
    const service = createWalletConversationService({
      conversations: repositoryFixture(),
      wallet,
      grantGate: { evaluate: gateEvaluate },
      grantLedger: { claim: ledgerClaim },
    });

    // The model's tool path: a dry-run send_token output persisted as preview.
    const result = await service.persistNativePreview({
      conversationId,
      userId,
      session: { id: conversationId } as never,
      input: {
        network: "sepolia",
        token: "USDT",
        to: recipient,
        amount: "10",
        wallet: "agent-demo",
        dryRun: true,
      } as never,
      output: {
        preview: true,
        network: "sepolia",
        token: "USDT",
        to: recipient,
        amount: "10",
        estimatedFee: "0.1",
        estimatedFeeFormatted: "0.1",
      },
    });

    // Preview persisted with the standard pending-confirmation semantics.
    expect(JSON.stringify(result)).toContain("previewId");
    // Model-origin: gate NOT consulted, ledger NOT claimed, nothing broadcast.
    expect(gateEvaluate).not.toHaveBeenCalled();
    expect(ledgerClaim).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("tool preview + explicit user confirm broadcasts exactly once (no grant involved)", async () => {
    const wallet = new FixtureWalletProvider();
    const broadcast = vi.spyOn(wallet, "broadcastTransfer");
    const ledgerClaim = vi.fn(async () => ({ consumed: true }));
    const gateEvaluate = vi.fn(async () => ({ covered: false }));
    const service = createWalletConversationService({
      conversations: repositoryFixture(),
      wallet,
      grantGate: { evaluate: gateEvaluate },
      grantLedger: { claim: ledgerClaim },
    });

    // Model tool path persists a preview (gate never consulted).
    const preview = await service.persistNativePreview({
      conversationId,
      userId,
      session: { id: conversationId } as never,
      input: {
        network: "sepolia",
        token: "USDT",
        to: recipient,
        amount: "10",
        wallet: "agent-demo",
        dryRun: true,
      } as never,
      output: {
        preview: true,
        network: "sepolia",
        token: "USDT",
        to: recipient,
        amount: "10",
        estimatedFee: "0.1",
        estimatedFeeFormatted: "0.1",
      },
    });
    const previewId = (preview as { previewId?: string }).previewId;
    expect(previewId).toBeDefined();

    // The user's EXPLICIT confirm is the authorization; the gate/ledger stay
    // out of it because the preview is tool-origin.
    const events: any[] = [];
    for await (const event of service.resolveDecision({
      conversationId,
      userId,
      previewId: previewId!,
      decision: "confirm",
      waitForFinancialTask: true,
    }))
      events.push(event);
    const turn = events.find((e) => e.type === "turn-completed")?.result;
    expect(turn?.status).toBe("sent");
    expect(broadcast).toHaveBeenCalledOnce();
    expect(gateEvaluate).not.toHaveBeenCalled();
    expect(ledgerClaim).not.toHaveBeenCalled();
  });
});
