import type { FastifyInstance } from "fastify";
import type { DatabaseClient } from "../db/client.js";
import { resolveWebhookWalletIdentity } from "../notifications/identity-resolution.js";
import { verifyProviderWebhook } from "../notifications/webhook-verification.js";
import { canonicalDedupeKey } from "../notifications/ingestion.js";
import { insertNotificationRow } from "../notifications/notification-repository.js";

export type WebhookRouteDependencies = {
  database: DatabaseClient;
  webhookSecret: string;
  /**
   * Optional transient fan-out invoked strictly AFTER the ingestion
   * transaction commits and only when the canonical notification insert won.
   * When absent, feed polling remains the discovery path (task 3.x wires the
   * LiveKit revision publisher).
   */
  publishInvalidation?: (deliveryId: string) => Promise<void>;
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
 * Contract:
 * 1. The route owns a raw-buffer content-type parser so the Svix signature is
 *    verified over the EXACT request bytes — never over parsed/re-serialized
 *    JSON, which changes the signed content.
 * 2. Identity resolution binds BOTH the verified provider account ID and the
 *    exact enrolled wallet address; ownership comes only from the enrollment
 *    record (payload user IDs are ignored).
 * 3. Receipt + notification commit in ONE transaction that starts in system
 *    context (app.user_id unset → system-only ingestion policies apply),
 *    returns early on duplicate delivery, then switches app.user_id to the
 *    resolved owner for the canonical notification insert. A crash anywhere
 *    before commit leaves nothing behind; a retry redoes the whole path.
 * 4. The transient LiveKit revision publishes only AFTER the transaction has
 *    committed, and only for the winning insert.
 * 5. Invalid signatures, tampered bytes, and un-enrolled verified wallets
 *    acknowledge without side effects (or are rejected before persistence).
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
    const walletAddress = asString(payload.wallet_address);
    if (!accountId || !deliveryId || !walletAddress) {
      return reply
        .status(400)
        .send({ ok: false, error: { code: "invalid_webhook_payload" } });
    }

    // 3. One transaction via the anonymous (system-context) helper: receipt
    // dedupe and identity resolution run while app.user_id is empty, the
    // insert re-scopes to the resolved owner. Any failure rolls everything
    // back, so retries never see a poisoned half-state.
    let notificationInserted = false;
    await dependencies.database.withSystemTransaction(async (client) => {
      // 3a. System context: scoped delivery receipt dedupe.
      const receipt = await client.query<{ id: string }>(
        `INSERT INTO provider_webhook_receipts (provider, account_id, delivery_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, account_id, delivery_id) DO NOTHING
         RETURNING id`,
        [provider, accountId, deliveryId],
      );
      if (receipt.rows.length === 0) {
        // Duplicate delivery: acknowledge without another event/notification.
        return;
      }

      // 3b. Identity resolution binds BOTH verified account AND address.
      const enrolled = await client.query<{
        id: string;
        user_id: string;
        network: string;
      }>(
        `SELECT id, user_id, COALESCE(chain_family, 'solana') AS network
         FROM user_wallets
         WHERE provider_wallet_id = $1 AND provider = 'privy'
           AND state = 'ready' AND address = $2
         ORDER BY verified_at DESC NULLS LAST LIMIT 1`,
        [accountId, walletAddress],
      );
      const wallet = enrolled.rows[0];
      if (!wallet) {
        // Verified signature but un-enrolled/mismatched wallet: acknowledge
        // without side effects rather than inventing an owner.
        return;
      }

      // 3c. Re-scope to the resolved owner for the feed insert (wallet
      // notifications policy requires app.user_id = user_id).
      await client.query("SELECT set_config('app.user_id', $1, true)", [
        wallet.user_id,
      ]);
      const outcome = await insertNotificationRow(client, {
        kind: "wallet_event",
        userId: wallet.user_id,
        walletId: wallet.id,
        dedupeKey: canonicalDedupeKey({
          network: wallet.network,
          walletAddress,
          signature: asString(payload.tx_hash) ?? deliveryId,
          eventClass: asString(payload.type) ?? "unknown",
        }),
        category: "wallet_event",
        status: "deposit",
        title: "Actividad en tu wallet",
        explanation: "Detectamos actividad confirmada en tu wallet.",
        resolved: true,
        projection: { status: "deposit", network: wallet.network },
      });
      notificationInserted = outcome.inserted;
    });

    // 4. Post-commit transient fan-out via the optional publisher dependency.
    // When no publisher is wired yet, feed polling remains the discovery path.
    if (notificationInserted && dependencies.publishInvalidation) {
      await dependencies.publishInvalidation(deliveryId);
    }
    return reply.status(200).send({ ok: true });
  });
}
