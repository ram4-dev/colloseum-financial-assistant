import { afterEach, describe, expect, it, vi } from "vitest";

import { startAssistantOutboxWorker } from "../../../src/notifications/outbox-worker.js";

describe("assistant outbox worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("dispatches immediately, backs off after a failure, and resumes its interval after success", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const failure = new Error("database unavailable");
    const dispatch = vi.fn<() => Promise<void>>().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const onError = vi.fn();
    const worker = startAssistantOutboxWorker({
      dispatch,
      intervalMs: 30_000,
      backoffOptions: { baseSeconds: 2, maxSeconds: 30 },
      onError,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure, 1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledTimes(3);
    await worker.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop waits for an active dispatch and does not schedule another pass", async () => {
    vi.useFakeTimers();
    let finishDispatch!: () => void;
    const dispatch = vi.fn(
      () => new Promise<void>((resolve) => (finishDispatch = resolve)),
    );
    const worker = startAssistantOutboxWorker({
      dispatch,
      intervalMs: 1_000,
      backoffOptions: { baseSeconds: 1, maxSeconds: 10 },
    });

    await vi.advanceTimersByTimeAsync(0);
    const stopped = worker.stop();
    finishDispatch();
    await stopped;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
