import { createHmac, timingSafeEqual } from "node:crypto";

const TIMESTAMP_TOLERANCE_SECONDS = 300;

export type WebhookVerificationRequest = {
  rawBody: Buffer;
  headers: {
    "svix-id"?: string;
    "svix-timestamp"?: string;
    "svix-signature"?: string;
  };
  secret: string;
  nowSeconds?: number;
};

export type WebhookVerificationResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_headers"
        | "invalid_signature"
        | "timestamp_out_of_window";
    };

/**
 * Verify a provider webhook signature over the exact raw request bytes
 * (Svix-style): HMAC-SHA256 over `{id}.{timestamp}.{body}` using the
 * base64-decoded key bytes from the `whsec_` secret. The signature must be
 * checked before any payload parsing, persistence, or fan-out.
 */
export function verifyProviderWebhook(
  request: WebhookVerificationRequest,
): WebhookVerificationResult {
  const id = request.headers["svix-id"];
  const timestampHeader = request.headers["svix-timestamp"];
  const signatureHeader = request.headers["svix-signature"];
  if (!id || !timestampHeader || !signatureHeader) {
    return { ok: false, reason: "missing_headers" };
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: "timestamp_out_of_window" };
  }
  const nowSeconds = request.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp_out_of_window" };
  }

  // Svix v1: the suffix after whsec_ is base64-encoded secret bytes.
  const secretKey = Buffer.from(
    request.secret.replace(/^whsec_/, ""),
    "base64",
  );
  const signedContent = `${id}.${timestampHeader}.${request.rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", secretKey)
    .update(signedContent)
    .digest("base64");

  // Accept any v1 signature entry that matches (comma/space separated list).
  const provided = signatureHeader
    .split(/[\s,]+/)
    .map((entry) => entry.replace(/^v1,/, "").trim())
    .filter(Boolean);
  const expectedBytes = Buffer.from(expected, "base64");
  const matched = provided.some((entry) => {
    const entryBytes = Buffer.from(entry, "base64");
    return (
      entryBytes.length === expectedBytes.length &&
      timingSafeEqual(entryBytes, expectedBytes)
    );
  });

  return matched ? { ok: true } : { ok: false, reason: "invalid_signature" };
}
