export type ReconciliationPage = {
  signatures: string[];
  nextCursor: string;
};

export type NextCursorPageOptions = {
  initialCursor: string | null;
  fetchPage: (cursor: string | null) => Promise<ReconciliationPage>;
  processSignature: (signature: string) => Promise<void>;
  maxAttempts: number;
  onPageError?: (error: unknown, signature: string, attempt: number) => void;
};

/**
 * Overlap-safe page processing: every signature of a page is processed in
 * order (oldest first); a failure retries the SAME signature without
 * advancing, and the page cursor is returned only after the whole page is
 * durably processed. Cursor progress never skips a failed event.
 */
export async function nextCursorPage(
  options: NextCursorPageOptions,
): Promise<string> {
  const { initialCursor, fetchPage, processSignature, maxAttempts } = options;
  // The page is fetched ONCE per run and kept in memory: a failing signature
  // is retried in place (same signature, no cursor advance, no re-fetch) so
  // already-processed signatures are not reprocessed. A process restart
  // re-fetches the whole page from the persisted cursor and dedupes via the
  // canonical ingestion identity.
  const page = await fetchPage(initialCursor);
  let index = 0;
  let attempt = 0;
  while (index < page.signatures.length) {
    const signature = page.signatures[index]!;
    try {
      await processSignature(signature);
      index += 1;
    } catch (error) {
      attempt += 1;
      options.onPageError?.(error, signature, attempt);
      if (attempt >= maxAttempts) {
        throw error;
      }
    }
  }
  return page.nextCursor;
}

export type ReconciliationBackoffOptions = {
  attempt: number;
  baseSeconds: number;
  maxSeconds: number;
};

/**
 * Bounded exponential backoff with jitter: base * 2^(attempt-1), capped at
 * maxSeconds, jittered ±25% so concurrent workers do not align retries.
 */
export function computeReconciliationBackoff(
  options: ReconciliationBackoffOptions,
): number {
  const exponential =
    options.baseSeconds * Math.pow(2, Math.max(0, options.attempt - 1));
  const capped = Math.min(exponential, options.maxSeconds);
  const jitter = capped * 0.25;
  return Math.min(
    options.maxSeconds,
    Math.max(options.baseSeconds, capped - jitter + Math.random() * jitter * 2),
  );
}
