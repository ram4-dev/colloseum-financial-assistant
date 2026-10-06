import type { FastifyInstance } from "fastify";
import type { DatabaseClient } from "../db/client.js";
import { verifyProviderWebhook } from "../notifications/webhook-verification.js";

export type WebhookRouteDependencies = {
  database: DatabaseClient;
  webhookSecret: string;
};

type ProviderWebhookPayload = {
  type?: unknown;
  account_id?: unknown;
  wallet_address?: unknown;
  user_id?: unknown;
  tx_hash?: unknown;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Provider webhook ingress (Slice 5).
 *
 * Contract (RECEIPT-ONLY until a documented embedded-wallet event contract
 * is proven — see 02-research.md):
 * 1. The route owns a raw-buffer content-type parser so the Svix signature is
 *    verified over the EXACT request bytes — never over parsed/re-serialized
 *    JSON, which changes the signed content.
 * 2. Only the verified provider account ID + Svix delivery ID are retained,
 *    for scoped receipt dedupe (system-context-only table).
 * 3. No wallet_event/notification/fan-out is produced: a signed generic
 *    payload proves delivery authenticity, NOT a confirmed inbound deposit.
 *    Canonical feed rows come exclusively from the Solana devnet reconciler.
 * 4. Invalid signatures and tampered bytes are rejected before any
 *    persistence; duplicates dedupe to one receipt.
 */
export async function registerProviderWebhookRoutes(
  app: FastifyInstance,
  dependencies: WebhookRouteDependencies,
): Promise<void> {
  // Raw-byte parser scoped to this route: application/json bodies are exposed
  // as a Buffer on request.body so signature verification sees original bytes.
  app.removeContentTypeParser?.("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.post("/v1/webhooks/provider", async (request, reply) => {
    const rawBody = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(String(request.body ?? ""), "utf8");

    // 1. Raw-byte signature verification before any payload trust.
    const verification = verifyProviderWebhook({
      rawBody,
      headers: {
        "svix-id": request.headers["svix-id"] as string | undefined,
        "svix-timestamp": request.headers["svix-timestamp"] as
          | string
          | undefined,
        "svix-signature": request.headers["svix-signature"] as
          | string
          | undefined,
      },
      secret: dependencies.webhookSecret,
    });
    if (!verification.ok) {
      return reply.status(401).send({
        ok: false,
        error: {
          code: "invalid_webhook_signature",
          reason: verification.reason,
        },
      });
    }

    // 2. Parse only after verification succeeded.
    let payload: ProviderWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as ProviderWebhookPayload;
    } catch {
      return reply
        .status(400)
        .send({ ok: false, error: { code: "invalid_webhook_payload" } });
    }

    const provider = "privy";
    const accountId = asString(payload.account_id);
    const deliveryId = asString(
      request.headers["svix-id"] as string | undefined,
    );
    // Receipt-only scope: verified account ID + delivery ID. No
    // wallet_address requirement — ownership resolution is the
    // reconciler's job from chain evidence, not the webhook's.
    if (!accountId || !deliveryId) {
      return reply
        .status(400)
        .send({ ok: false, error: { code: "invalid_webhook_payload" } });
    }

    // 3. Receipt-only audit: research (02-research.md) explicitly found
    // NO verified Privy embedded-wallet chain-event contract. A signed
    // generic payload proves delivery authenticity, NOT a confirmed
    // inbound deposit — so this endpoint persists only the scoped dedupe
    // receipt (system context) and acknowledges. Canonical wallet_event
    // notifications are created exclusively by the Solana devnet
    // reconciler from actual chain evidence. If a documented
    // embedded-wallet event contract is later validated, re-enable
    // notification insertion behind that exact allowlisted event type.
    await dependencies.database.withSystemTransaction(async (client) => {
      // Scoped delivery receipt dedupe; duplicates acknowledge without
      // another receipt, event, or notification.
      await client.query<{ id: string }>(
        `INSERT INTO provider_webhook_receipts (provider, account_id, delivery_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, account_id, delivery_id) DO NOTHING
         RETURNING id`,
        [provider, accountId, deliveryId],
      );
    });

    // Receipt-only: no notification insert, no fan-out. The durable feed
    // is populated by the reconciler from chain evidence.
    return reply.status(200).send({ ok: true });
  });
}
