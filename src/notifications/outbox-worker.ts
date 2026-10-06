import { computeReconciliationBackoff } from "./reconciliation.js";

export type AssistantOutboxWorkerOptions = {
  dispatch: () => Promise<unknown>;
  intervalMs: number;
  backoffOptions: { baseSeconds: number; maxSeconds: number };
  onError?: (error: unknown, attempt: number) => void;
};

/**
 * Polls the durable assistant outbox immediately and then at a bounded
 * interval. Failures never lose rows: the DB dispatcher leaves them pending,
 * while this loop backs off and retries. stop() clears the timer and waits for
 * an active pass, so callers can close the database afterward.
 */
export function startAssistantOutboxWorker(options: AssistantOutboxWorkerOptions) {
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = inFlight
        .then(async () => {
          await options.dispatch();
          attempt = 0;
        })
        .catch((error: unknown) => {
          attempt += 1;
          try {
            options.onError?.(error, attempt);
          } catch {
            // Logging hooks cannot stop persistence retries.
          }
        })
        .finally(() => {
          const delay =
            attempt === 0
              ? options.intervalMs
              : computeReconciliationBackoff({
                  attempt,
                  baseSeconds: options.backoffOptions.baseSeconds,
                  maxSeconds: options.backoffOptions.maxSeconds,
                }) * 1000;
          schedule(delay);
        });
    }, delayMs);
  }

  schedule(0);
  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
