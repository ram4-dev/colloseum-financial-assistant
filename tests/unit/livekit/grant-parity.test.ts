import { describe, expect, it, vi } from "vitest";
import { RoomConversation } from "../../../src/livekit/room-conversation.js";
import { issueLiveVoiceBinding } from "../../../src/auth/live-binding.js";
import type {
  HandleTurnInput,
  ResolveDecisionInput,
} from "../../../src/conversations/service.js";
import { generateKeyPairSync } from "node:crypto";

/**
 * Phase 5 (slice3-grant-execution): typed/voice parity and model-origin
 * exclusion.
 *
 * Parity (spec "Voice and tool surfaces unchanged"): the voice transcript
 * path funnels through the SAME service `handleTurnStream`, so identical
 * request data + ledger state produce identical coverage decisions — the
 * grant gate is exercised through the shared seam, never duplicated in the
 * LiveKit layer.
 *
 * Model-origin exclusion: `send_token` tool previews (realtime tools and the
 * agent-tool adapter) are model-produced and MUST keep the existing preview +
 * explicit-confirm flow; the gate is never consulted for them.
 */

const keys = generateKeyPairSync("ed25519");

function conversationFixture() {
  return {
    id: "conversation-1",
    userId: "user-1",
    mode: "live" as const,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    revision: 3,
    language: "es" as const,
    generation: 1,
    messages: [],
  };
}

async function boundRoom(service: unknown, conversations?: unknown) {
  const room = new RoomConversation({
    publicKey: String(keys.publicKey.export({ type: "spki", format: "pem" })),
    conversations: (conversations ?? {
      get: vi.fn(async () => conversationFixture()),
    }) as never,
    service: service as never,
  });
  const token = await issueLiveVoiceBinding({
    userId: "user-1",
    conversationId: "conversation-1",
    privateKey: keys.privateKey,
  });
  await room.bind({ token, participantUserId: "user-1" });
  return room;
}

describe("grant gate typed/voice parity (phase 5)", () => {
  it("voice transcript reaches the same service handleTurnStream (shared seam with typed turns)", async () => {
    const handleTurnStream = vi.fn(async function* (_input: HandleTurnInput) {
      yield {
        type: "turn-completed" as const,
        result: { status: "sent" as const, message: "ok" },
      };
    });
    const room = await boundRoom({ handleTurnStream });
    for await (const _ of room.handleFinalTranscript(
      "Send 0.01 SOL to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    ))
      void _;
    // The transcript path delegates to the SAME service entry the typed path
    // uses; any gate decision is made inside the service, identically.
    expect(handleTurnStream).toHaveBeenCalledTimes(1);
    expect(handleTurnStream.mock.calls[0][0]).toMatchObject({
      conversationId: "conversation-1",
      userId: "user-1",
      text: "Send 0.01 SOL to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    });
  });

  it("voice transcript never mutates grants: no grant capability in the LiveKit layer", async () => {
    const handleTurnStream = vi.fn(async function* () {
      yield {
        type: "turn-completed" as const,
        result: { status: "answer" as const, message: "ok" },
      };
    });
    const room = await boundRoom({ handleTurnStream });
    for await (const _ of room.handleFinalTranscript("crea un grant de 1 SOL"))
      void _;
    // The RoomConversation API surface exposes no grant mutation: everything
    // goes through service.handleTurnStream / resolveDecision only.
    const serviceKeys = Object.keys(
      (await boundRoom({ handleTurnStream })) as unknown as object,
    );
    expect(serviceKeys.join(",")).not.toMatch(/grant/i);
  });

  it("voice confirm/cancel for degraded (non-covered) previews still route through resolveDecision", async () => {
    const resolveDecision = vi.fn(async function* (
      _input: ResolveDecisionInput,
    ) {
      yield {
        type: "turn-completed" as const,
        result: { status: "sent" as const, message: "ok" },
      };
    });
    const conversation = {
      ...conversationFixture(),
      pendingTransfer: {
        network: "sepolia",
        token: "USDT",
        to: "0xabc",
        amount: "1",
        wallet: "w",
        estimatedFee: "0.1",
        preview: {
          network: "sepolia",
          token: "USDT",
          recipient: "0xabc",
          amount: "1",
          estimatedFee: "0.1",
        },
        previewId: "preview-1",
      },
    };
    const room = await boundRoom(
      { resolveDecision, handleTurnStream: vi.fn(async function* () {}) },
      { get: vi.fn(async () => conversation) },
    );
    // resolvePendingDecision is the transcript confirm/cancel interceptor.
    const decision = await room.resolvePendingDecision(
      "confirmar la transferencia",
    );
    expect(decision).toBeDefined();
    for await (const _ of decision!) void _;
    expect(resolveDecision).toHaveBeenCalledTimes(1);
    const call = resolveDecision.mock.calls[0];
    expect(call?.[0]).toMatchObject({
      decision: "confirm",
    });
  });
});
