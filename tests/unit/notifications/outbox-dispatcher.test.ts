import { describe, expect, it, vi } from "vitest";

import {
  dispatchPendingAssistantEvents,
  type AssistantOutboxDependencies,
  type OutboxInvalidation,
  type PendingAssistantOutboxEvent,
} from "../../../src/notifications/outbox-dispatcher.js";

function pendingEvent(
  overrides: Partial<PendingAssistantOutboxEvent> = {},
): PendingAssistantOutboxEvent {
  return {
    attemptId: "0b7f8c1e-0000-4000-8000-000000000001",
    userId: "0b7f8c1e-0000-4000-8000-000000000003",
    status: "confirmed",
    dedupeKey: `assistant-transfer:0b7f8c1e-0000-4000-8000-000000000001:confirmed`,
    ...overrides,
  };
}

/**
 * Shared fake persisted state: pending outbox events and canonical
 * notification rows live across dispatcher invocations, simulating the
 * durable database so a "fresh process" run sees what the previous run left.
 */
function makeState() {
  return {
    pending: [pendingEvent()],
    notifications: [] as { userId: string; dedupeKey: string }[],
  };
}

function dependencies(
  state: ReturnType<typeof makeState>,
  overrides: Partial<AssistantOutboxDependencies> = {},
): AssistantOutboxDependencies & {
  commitNotificationAndCompleteEvent: (
    event: PendingAssistantOutboxEvent,
  ) => Promise<{ committed: boolean; invalidation?: OutboxInvalidation }>;
  publishInvalidation: (event: OutboxInvalidation) => Promise<void>;
} {
  const commitNotificationAndCompleteEvent = vi.fn(
    async (
      event: PendingAssistantOutboxEvent,
    ): Promise<{ committed: boolean; invalidation?: OutboxInvalidation }> => {
      state.notifications.push({
        userId: event.userId,
        dedupeKey: event.dedupeKey,
      });
      state.pending = state.pending.filter(
        (candidate) =>
          !(
            candidate.attemptId === event.attemptId &&
            candidate.status === event.status
          ),
      );
      return { committed: true };
    },
  );
  const publishInvalidation = vi.fn(
    async (_event: OutboxInvalidation): Promise<void> => undefined,
  );
  const deps: AssistantOutboxDependencies = {
    loadPendingEvents: vi.fn(async () => state.pending),
    commitNotificationAndCompleteEvent,
    publishInvalidation,
    ...overrides,
  };
  return deps as AssistantOutboxDependencies & {
    commitNotificationAndCompleteEvent: typeof commitNotificationAndCompleteEvent;
    publishInvalidation: typeof publishInvalidation;
  };
}

describe("assistant lifecycle outbox dispatcher (restart recovery contract)", () => {
  it("a failed commit leaves the event pending, a fresh run retries the same state once, and a replay is a no-op", async () => {
    const state = makeState();
    const order: string[] = [];

    // Run 1 (crash simulation): the atomic commit itself fails; neither the
    // notification nor the completion may land.
    const failingRun = dependencies(state, {
      commitNotificationAndCompleteEvent: vi.fn(async () => {
        throw new Error("process stopped before atomic commit");
      }),
    });
    await expect(dispatchPendingAssistantEvents(failingRun)).rejects.toThrow(
      "process stopped before atomic commit",
    );

    // Persisted state proves the crash gap is closed: event still pending,
    // zero notifications, and no invalidation for the incomplete run.
    expect(state.pending).toHaveLength(1);
    expect(state.notifications).toHaveLength(0);
    expect(failingRun.publishInvalidation).not.toHaveBeenCalled();

    // Run 2 (fresh process): the SAME state is retried; the pending event
    // left by the failed run commits exactly once, and the publish happens
    // only after the atomic commit succeeded.
    const freshRun = dependencies(state, {
      commitNotificationAndCompleteEvent: vi.fn(async (event) => {
        order.push("commit");
        state.notifications.push({
          userId: event.userId,
          dedupeKey: event.dedupeKey,
        });
        state.pending = state.pending.filter(
          (candidate) =>
            !(
              candidate.attemptId === event.attemptId &&
              candidate.status === event.status
            ),
        );
        return {
          committed: true,
          invalidation: {
            type: "conversation_state_changed" as const,
            conversationId: "conv-1",
            revision: 1,
          },
        };
      }),
      publishInvalidation: vi.fn(async () => {
        order.push("publish");
      }),
    });
    const result = await dispatchPendingAssistantEvents(freshRun);
    expect(result.dispatched).toBe(1);
    expect(freshRun.commitNotificationAndCompleteEvent).toHaveBeenCalledTimes(
      1,
    );
    expect(freshRun.commitNotificationAndCompleteEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: pendingEvent().attemptId,
        status: "confirmed",
      }),
    );
    expect(state.pending).toHaveLength(0);
    expect(state.notifications).toHaveLength(1);
    expect(order).toEqual(["commit", "publish"]);

    // Run 3 (replay against the same state): no pending events remain; the
    // dispatcher is a full no-op.
    const replay = dependencies(state);
    const replayResult = await dispatchPendingAssistantEvents(replay);
    expect(replayResult.dispatched).toBe(0);
    expect(replay.commitNotificationAndCompleteEvent).not.toHaveBeenCalled();
    expect(replay.publishInvalidation).not.toHaveBeenCalled();
  });

  it("does not publish invalidation when the atomic commit loses the dedupe race", async () => {
    const state = makeState();
    const loserRun = dependencies(state, {
      // The atomic commit resolved the insert as an already-canonical loser.
      commitNotificationAndCompleteEvent: vi.fn(async (event) => {
        state.pending = state.pending.filter(
          (candidate) =>
            !(
              candidate.attemptId === event.attemptId &&
              candidate.status === event.status
            ),
        );
        return { committed: false };
      }),
    });
    const result = await dispatchPendingAssistantEvents(loserRun);
    expect(result.dispatched).toBe(0);
    expect(loserRun.publishInvalidation).not.toHaveBeenCalled();
  });
});
