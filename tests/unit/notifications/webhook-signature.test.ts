import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyProviderWebhook } from "../../../src/notifications/webhook-verification.js";

// Svix v1: the suffix after whsec_ is base64-encoded secret bytes; the HMAC
// key is those decoded bytes, not the literal whsec_ string.
const SECRET_BYTES_BASE64 = "rOVC0woIVF8NaBn2utX1Ll/EvV1rl+TDpqxD+uGV3ms=";
const SECRET = `whsec_${SECRET_BYTES_BASE64}`;
// Separately encoded attacker key for the wrong-secret case.
const ATTACKER_BYTES_BASE64 = Buffer.from(
  "attacker-controlled-secret-bytes-0000",
  "utf8",
).toString("base64");

function sign(signedContent: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(signedContent).digest("base64")}`;
}

function rawRequest(options: {
  body?: string;
  timestampSeconds?: number;
  nowSeconds?: number;
  secret?: string;
  signature?: string;
  deliveryId?: string;
}) {
  const body =
    options.body ?? JSON.stringify({ type: "wallet.transaction.confirmed" });
  const timestamp = String(options.timestampSeconds ?? 1_700_000_000);
  const deliveryId = options.deliveryId ?? "msg_01HVQKSPFJ8Z0XAMPLE000000";
  const signature =
    options.signature ??
    sign(`${deliveryId}.${timestamp}.${body}`, options.secret);
  return {
    rawBody: Buffer.from(body, "utf8"),
    headers: {
      "svix-id": deliveryId,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    },
    secret: options.secret ?? SECRET,
    nowSeconds: options.nowSeconds ?? 1_700_000_000,
  };
}

describe("provider webhook signature verification (raw bytes)", () => {
  it("accepts a valid Svix-style signature over the exact raw request bytes", () => {
    const request = rawRequest({});
    const result = verifyProviderWebhook(request);
    expect(result).toEqual({ ok: true });
  });

  it("rejects a signature computed over different bytes than the raw body", () => {
    // The parsed/re-serialized body differs from the signed raw bytes.
    const request = rawRequest({
      body: '{"type":"wallet.transaction.confirmed"}',
    });
    const tampered = {
      ...request,
      rawBody: Buffer.from('{"type": "wallet.transaction.confirmed"}', "utf8"),
    };
    const result = verifyProviderWebhook(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  it("rejects a signature made with a different secret", () => {
    // The signature is forged with an attacker-controlled key while the
    // verifier holds the legitimate signing secret: HMAC keys differ.
    const attackerSecret = `whsec_${ATTACKER_BYTES_BASE64}`;
    const forged = sign(
      `msg_01HVQKSPFJ8Z0XAMPLE000000.1700000000.${JSON.stringify({ type: "wallet.transaction.confirmed" })}`,
      attackerSecret,
    );
    const request = rawRequest({ secret: SECRET, signature: forged });
    const result = verifyProviderWebhook(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  it("accepts a timestamp exactly at the 300-second past boundary and rejects beyond it", () => {
    const nowSeconds = 1_700_000_000;
    const atBoundary = verifyProviderWebhook(
      rawRequest({ timestampSeconds: nowSeconds - 300, nowSeconds }),
    );
    expect(atBoundary).toEqual({ ok: true });

    const beyondBoundary = verifyProviderWebhook(
      rawRequest({ timestampSeconds: nowSeconds - 301, nowSeconds }),
    );
    expect(beyondBoundary.ok).toBe(false);
    if (!beyondBoundary.ok)
      expect(beyondBoundary.reason).toBe("timestamp_out_of_window");
  });

  it("accepts a timestamp exactly at the 300-second future boundary and rejects beyond it", () => {
    const nowSeconds = 1_700_000_000;
    const atBoundary = verifyProviderWebhook(
      rawRequest({ timestampSeconds: nowSeconds + 300, nowSeconds }),
    );
    expect(atBoundary).toEqual({ ok: true });

    const beyondBoundary = verifyProviderWebhook(
      rawRequest({ timestampSeconds: nowSeconds + 301, nowSeconds }),
    );
    expect(beyondBoundary.ok).toBe(false);
    if (!beyondBoundary.ok)
      expect(beyondBoundary.reason).toBe("timestamp_out_of_window");
  });

  it("rejects requests missing any required signature header", () => {
    const complete = rawRequest({});
    const withoutId = {
      ...complete,
      headers: { ...complete.headers, "svix-id": undefined },
    };
    const withoutSignature = {
      ...complete,
      headers: { ...complete.headers, "svix-signature": undefined },
    };
    expect(verifyProviderWebhook(withoutId).ok).toBe(false);
    expect(verifyProviderWebhook(withoutSignature).ok).toBe(false);
  });
});
