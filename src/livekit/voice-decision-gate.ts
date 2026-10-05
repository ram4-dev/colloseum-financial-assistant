export type VoiceDecision = "confirm" | "cancel";
export type VoiceDecisionResult = "confirmed" | "cancelled";

export type VoiceDecisionGate = ReturnType<typeof createVoiceDecisionGate>;

/**
 * Per-session, one-use authorization evidence for an explicitly spoken
 * decision. Evidence is available only after a persisted preview's complete
 * read-back has played without interruption.
 */
export function createVoiceDecisionGate(classifiers: {
  isConfirmation(text: string): boolean;
  isCancellation(text: string): boolean;
}) {
  let activePreviewId: string | undefined;
  let armed = false;
  let narrationCompletedAt: number | undefined;
  let evidence: VoiceDecisionResult | undefined;

  return {
    prepare(previewId: string): void {
      if (!previewId) {
        activePreviewId = undefined;
        armed = false;
        narrationCompletedAt = undefined;
        evidence = undefined;
        return;
      }
      activePreviewId = previewId;
      armed = false;
      narrationCompletedAt = undefined;
      evidence = undefined;
    },

    completeNarration(previewId: string, result: { interrupted: boolean }): void {
      if (activePreviewId !== previewId) return;
      armed = !result.interrupted;
      narrationCompletedAt = result.interrupted ? undefined : Date.now();
      evidence = undefined;
    },

    recordTranscript(input: {
      previewId: string;
      text: string;
      isFinal: boolean;
      authenticatedSpeaker: boolean;
      createdAt: number;
    }): void {
      if (
        !armed ||
        !input.isFinal ||
        input.authenticatedSpeaker !== true ||
        narrationCompletedAt === undefined ||
        !Number.isFinite(input.createdAt) ||
        input.createdAt <= narrationCompletedAt
      ) {
        return;
      }
      if (classifiers.isConfirmation(input.text)) evidence = "confirmed";
      else if (classifiers.isCancellation(input.text)) evidence = "cancelled";
    },

    consume(previewId: string, decision: VoiceDecision): VoiceDecisionResult | undefined {
      if (previewId !== activePreviewId) return undefined;
      const expected = decision === "confirm" ? "confirmed" : "cancelled";
      if (!armed || evidence !== expected) return undefined;
      evidence = undefined;
      armed = false;
      return expected;
    },

    clear(previewId: string): void {
      if (previewId !== activePreviewId) return;
      activePreviewId = undefined;
      armed = false;
      narrationCompletedAt = undefined;
      evidence = undefined;
    },
  };
}
