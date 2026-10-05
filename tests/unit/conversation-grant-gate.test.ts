import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWalletConversationService,
  type ConversationEvent,
} from "../../src/conversations/service.js";
import type { ConversationRepository } from "../../src/conversations/repository.js";
import type {
  ConversationSnapshot,
  ConversationState,
  WalletProgress,
} from "../../src/conversations/types.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";
import { FinancialTaskRegistry } from "../../src/conversations/financial-task-registry.js";

/**
 * Phase 3 RED (slice3-grant-execution): conversation service gate.
 *
 * Contract under test (phase 3 — adapter over the implemented gate):
 * - `WalletConversationDependencies` accepts optional `grantGate`:
 *   `{ evaluate(input): { covered: boolean } | null }` — a server-owned
 *   callback the service consults ONLY when the preview originates from
 *   the authenticated original user turn (the callback receives the turn
 *   text and performs its own server-side intent binding/origin checks;
 *   tool args can never set them).
 * - Covered (and claim-success in phase 4; here the classifier callback
 *   stub includes the claim outcome) ⇒ the turn resolves to a terminal
 *   `sent` result with NO `confirmation_required` and no confirm/cancel
 *   step.
 * - Degraded (null / not covered / missing deps) ⇒ today's exact
 *   `confirmation_required` preview flow.
 */

const userId = "11111111-1111-4111-8111-111111111111";
const recipient = "0x1234567890123456789012345678901234567890";

function repositoryFixture(): ConversationRepository {
  let snapshot: ConversationSnapshot = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId,
    mode: "typed",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    revision: 0,
    language: "es",
    generation: 1,
    messages: [],
  };
  let transferStatus:
    | "previewed"
    | "broadcasting"
    | "submitted"
    | "uncertain"
    | "confirmed"
    | "reverted"
    | "receipt_invalid"
    | "cancelled"
    | undefined = undefined;

  const repository = {
    async create() {
      return snapshot;
    },
    async get(requestUserId: string, id: string) {
      return requestUserId === userId && id === snapshot.id
        ? { ...snapshot, messages: [...snapshot.messages] }
        : undefined;
    },
    async inspect(requestUserId: string, id: string) {
      return this.get(requestUserId, id);
    },
    async appendMessage(
      _requestUserId: string,
      _id: string,
      message: ConversationSnapshot["messages"][number],
    ) {
      snapshot.messages.push(message);
    },
    async saveSnapshot(
      _requestUserId: string,
      incoming: ConversationSnapshot,
      _count: number,
    ) {
      snapshot = {
        ...incoming,
        pendingTransfer: incoming.pendingTransfer
          ? {
              ...incoming.pendingTransfer,
              previewId:
                incoming.pendingTransfer.previewId ??
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            }
          : undefined,
        revision: incoming.revision + 1,
      };
      if (snapshot.pendingTransfer) transferStatus = "previewed";
      return snapshot;
    },
    async updateState(
      _requestUserId: string,
      _id: string,
      _revision: number,
      state: ConversationState,
    ) {
      snapshot = { ...snapshot, ...state, revision: snapshot.revision + 1 };
      return snapshot;
    },
    async setProgress(
      _requestUserId: string,
      _id: string,
      progress: WalletProgress,
    ) {
      snapshot = { ...snapshot, progress, revision: snapshot.revision + 1 };
      return snapshot;
    },
    async setPendingTransfer(
      _requestUserId: string,
      _id: string,
      transfer: NonNullable<ConversationSnapshot["pendingTransfer"]>,
    ) {
      snapshot = {
        ...snapshot,
        pendingTransfer: { ...transfer },
        revision: snapshot.revision + 1,
      };
      transferStatus = "previewed";
      return snapshot;
    },
    async clearPendingTransfer() {
      transferStatus = "cancelled";
      snapshot = {
        ...snapshot,
        pendingTransfer: undefined,
        transferResolutionState: undefined,
        revision: snapshot.revision + 1,
      };
      return snapshot;
    },
    async cancelPendingTransfer(
      _requestUserId: string,
      _id: string,
      previewId: string,
    ) {
      if (
        transferStatus !== "previewed" ||
        snapshot.pendingTransfer?.previewId !== previewId
      )
        return "stale_preview" as const;
      transferStatus = "cancelled";
      snapshot = {
        ...snapshot,
        pendingTransfer: undefined,
        revision: snapshot.revision + 1,
      };
      return "cancelled" as const;
    },
    async claimPendingTransfer() {
      if (!snapshot.pendingTransfer) return { status: "missing" as const };
      if (transferStatus === "broadcasting")
        return { status: "broadcasting" as const };
      if (transferStatus === "uncertain")
        return { status: "uncertain" as const };
      transferStatus = "broadcasting";
      snapshot = {
        ...snapshot,
        transferResolutionState: "broadcasting",
        revision: snapshot.revision + 1,
      };
      const claimedTransfer = snapshot.pendingTransfer;
      if (!claimedTransfer) return { status: "missing" as const };
      return {
        status: "claimed" as const,
        transfer: { ...claimedTransfer, previewId: claimedTransfer.previewId! },
      };
    },
    async releasePendingTransferClaim() {
      transferStatus = "previewed";
      snapshot = { ...snapshot, transferResolutionState: undefined };
    },
    async markPendingTransferUncertain() {
      transferStatus = "uncertain";
      snapshot = {
        ...snapshot,
        transferResolutionState: "uncertain",
        revision: snapshot.revision + 1,
      };
    },
    async setLastTransactionHash(
      _requestUserId: string,
      _id: string,
      hash: string,
    ) {
      snapshot = { ...snapshot, lastTransactionHash: hash };
    },
    async markTransferSubmitted(
      _requestUserId: string,
      _id: string,
      hash: string,
    ) {
      transferStatus = "submitted";
      snapshot = {
        ...snapshot,
        lastTransactionHash: hash,
        revision: snapshot.revision + 1,
      };
    },
    async finalizeTransfer(
      _requestUserId: string,
      _id: string,
      result: {
        status: "confirmed" | "reverted" | "receipt_invalid";
        transactionHash: string;
      },
    ) {
      transferStatus = result.status;
      snapshot = {
        ...snapshot,
        pendingTransfer: undefined,
        transferResolutionState: undefined,
        lastTransactionHash: result.transactionHash,
        revision: snapshot.revision + 1,
      };
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

async function events(
  service: ReturnType<typeof createWalletConversationService>,
  input: Parameters<
    ReturnType<typeof createWalletConversationService>["handleTurnStream"]
  >[0],
): Promise<ConversationEvent[]> {
  const result: ConversationEvent[] = [];
  for await (const event of service.handleTurnStream(input)) result.push(event);
  return result;
}

describe("grant-covered conversation gate (phase 3 RED)", () => {
  const previousRuntime = process.env.AGENT_RUNTIME;
  const previousSource = process.env.WDK_TOOLS_SOURCE;

  beforeEach(() => {
    process.env.AGENT_RUNTIME = "deterministic";
    process.env.WDK_TOOLS_SOURCE = "fixture";
  });

  afterEach(() => {
    process.env.AGENT_RUNTIME = previousRuntime;
    process.env.WDK_TOOLS_SOURCE = previousSource;
  });

  it("RED: a covered typed request resolves to sent without confirmation_required", async () => {
    const grantGate = vi.fn(async () => ({ covered: true as const }));
    const conversations = repositoryFixture();
    const service = createWalletConversationService({
      conversations,
      wallet: new FixtureWalletProvider(),
      grantGate: { evaluate: grantGate },
    });
    const streamed = await events(service, {
      conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId,
      // Explicit transfer intent bound to this authenticated original turn.
      text: `Send 10 USDT to ${recipient}`,
    });
    const completed = streamed.find((event) => event.type === "turn-completed");
    expect(completed).toBeDefined();
    const turn = (
      completed as { type: "turn-completed"; result: { status: string } }
    ).result;
    expect(grantGate).toHaveBeenCalled();
    expect(turn.status).toBe("sent");
    expect(turn.status).not.toBe("confirmation_required");
    // The classifier was consulted with a server-owned, user-request origin.
    expect(grantGate).toHaveBeenCalled();
    const snapshot = await conversations.get(
      userId,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(snapshot?.messages).not.toContainEqual(
      expect.objectContaining({ role: "user", content: "confirm" }),
    );
  });

      it("RED: covered turn with financial tasks resolves to the terminal sent result", async () => {
        const grantGate = vi.fn(async () => ({ covered: true as const }));
        const registry = new FinancialTaskRegistry();
        const service = createWalletConversationService({
          conversations: repositoryFixture(),
          wallet: new FixtureWalletProvider(),
          grantGate: { evaluate: grantGate },
          financialTasks: registry,
        });
        const streamed = await events(service, {
          conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          userId,
          text: `Send 10 USDT to ${recipient}`,
        });
        const completed = streamed.find((event) => event.type === "turn-completed");
        const turn = (
          completed as { type: "turn-completed"; result: { status: string } }
        ).result;
        // waitForFinancialTask on the internal delegated_grant resolve yields
        // the terminal result, not the generic "Transfer is being processed."
        expect(turn.status).toBe("sent");
      });
    
      it("RED: a degraded request keeps the existing confirmation_required preview flow", async () => {
    const service = createWalletConversationService({
      conversations: repositoryFixture(),
      wallet: new FixtureWalletProvider(),
      grantGate: { evaluate: async () => ({ covered: false }) },
    });
    const streamed = await events(service, {
      conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId,
      text: `Send 10 USDT to ${recipient}`,
    });
    const completed = streamed.find((event) => event.type === "turn-completed");
    expect(completed).toBeDefined();
    const turn = (
      completed as { type: "turn-completed"; result: { status: string } }
    ).result;
    expect(turn.status).toBe("confirmation_required");
  });

  it("RED: absent grant dependency preserves today unconditional preview flow", async () => {
    const service = createWalletConversationService({
      conversations: repositoryFixture(),
      wallet: new FixtureWalletProvider(),
    });
    const streamed = await events(service, {
      conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId,
      text: `Send 10 USDT to ${recipient}`,
    });
    const completed = streamed.find((event) => event.type === "turn-completed");
    const turn = (
      completed as { type: "turn-completed"; result: { status: string } }
    ).result;
    expect(turn.status).toBe("confirmation_required");
  });
});
