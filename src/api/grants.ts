/**
 * DGC-5: /v1/grants — authenticated delegated-grant lifecycle (create, list,
 * revoke). Identity failures are 401 via the server-wide handler; foreign and
 * missing resources are indistinguishable 404 (same convention as /v1/wallets).
 * Grants are NEVER created, extended, or revoked through voice tools (D-3).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createDelegatedGrantRequestSchema,
  createDelegatedGrantResponseSchema,
  listDelegatedGrantsResponseSchema,
  revokeDelegatedGrantResponseSchema,
  type CreateDelegatedGrantResponse,
  type ListDelegatedGrantsResponse,
  type RevokeDelegatedGrantResponse,
} from "../contracts/http.js";
import {
  GrantWalletUnavailableError,
  InvalidGrantInputError,
  type DelegatedGrantService,
  type DelegatedGrantRow,
} from "../wallet/grants/consumption.js";
import type { PrivyPolicySyncService } from "../wallet/grants/privy-policy-sync.js";
import { PrivyIdentityError } from "../auth/privy-identity.js";

export type GrantsRouteDependencies = {
  grants: DelegatedGrantService;
  policySync: PrivyPolicySyncService;
  resolveUserId(request: FastifyRequest): Promise<string>;
};

type GrantsApiError = {
  ok: false;
  error: { code: string; message: string; field?: string };
};

function toGrantResponse(grant: DelegatedGrantRow) {
  return {
    id: grant.id,
    walletId: grant.walletId,
    action: grant.action,
    chain: grant.chain,
    maxPerTransfer: grant.maxPerTransfer,
    maxCumulative: grant.maxCumulative,
    windowSeconds: grant.windowSeconds,
    recipients: grant.recipients,
    state: grant.state,
    // The provider policy binding is the hybrid enforcement surface; revoked or
    // expired grants are never reported as executable even if cleanup remains.
    policyReady: grant.state === "active" && grant.providerPolicyId !== null,
    createdAt: grant.createdAt.toISOString(),
    expiresAt: grant.expiresAt.toISOString(),
    revokedAt: grant.revokedAt ? grant.revokedAt.toISOString() : null,
  };
}

function validationError(error: unknown): GrantsApiError | null {
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name: string }).name === "ZodError"
  ) {
    const issues = (error as { issues?: Array<{ path: string[]; message: string }> }).issues ?? [];
    return {
      ok: false,
      error: {
        code: "solicitud_invalida",
        message: "Invalid grant request.",
        field: issues[0]?.path.join(".") ?? undefined,
      },
    };
  }
  return null;
}

export async function registerGrantsRoutes(
  app: FastifyInstance,
  dependencies: GrantsRouteDependencies,
): Promise<void> {
  app.post(
    "/v1/grants",
    async (request, reply):
      Promise<{ ok: true; data: CreateDelegatedGrantResponse } | GrantsApiError> => {
      try {
        const userId = await dependencies.resolveUserId(request);
        const parsed = createDelegatedGrantRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({
            ok: false,
            error: {
              code: "solicitud_invalida",
              message: "Invalid grant request.",
              field: parsed.error.issues[0]?.path.join(".") ?? undefined,
            },
          });
        }
        const walletId = await dependencies.grants.resolveWalletId(
          userId,
          parsed.data.chain,
        );
        const created = await dependencies.grants.createGrant({
          userId,
          walletId,
          action: parsed.data.action,
          chain: parsed.data.chain,
          maxPerTransfer: parsed.data.maxPerTransfer,
          maxCumulative: parsed.data.maxCumulative,
          windowSeconds: parsed.data.windowSeconds,
          recipients: parsed.data.recipients,
          expiresAt: new Date(parsed.data.expiresAt),
        });
        // Provisioning is deliberately after the ledger transaction commits.
        // If the provider is unavailable, the grant remains visible but cannot
        // execute because policyReady stays false.
        await dependencies.policySync.syncGrant(
          created.id,
          userId,
          created.walletId,
        );
        const grant = (await dependencies.grants.getGrant(created.id, userId)) ?? created;
        const data = { grant: toGrantResponse(grant) };
        createDelegatedGrantResponseSchema.parse(data);
        return { ok: true, data };
      } catch (error) {
        if (error instanceof PrivyIdentityError) throw error;
        if (error instanceof GrantWalletUnavailableError) {
          return reply.code(409).send({
            ok: false,
            error: { code: "wallet_unavailable", message: error.message },
          });
        }
        if (error instanceof InvalidGrantInputError) {
          return reply.code(400).send({
            ok: false,
            error: { code: "solicitud_invalida", message: error.message, field: "maxPerTransfer" },
          });
        }
        const invalid = validationError(error);
        if (invalid) return reply.code(400).send(invalid);
        return reply.code(500).send({
          ok: false,
          error: { code: "ERROR_INTERNO", message: "Unexpected grants error." },
        });
      }
    },
  );

  app.get(
    "/v1/grants",
    async (request, reply):
      Promise<{ ok: true; data: ListDelegatedGrantsResponse } | GrantsApiError> => {
      try {
        const userId = await dependencies.resolveUserId(request);
        const grants = await dependencies.grants.listGrants(userId);
        const data = { grants: grants.map(toGrantResponse) };
        listDelegatedGrantsResponseSchema.parse(data);
        return { ok: true, data };
      } catch (error) {
        if (error instanceof PrivyIdentityError) throw error;
        return reply.code(500).send({
          ok: false,
          error: { code: "ERROR_INTERNO", message: "Unexpected grants error." },
        });
      }
    },
  );

  app.post(
    "/v1/grants/:grantId/revoke",
    async (request, reply):
      Promise<{ ok: true; data: RevokeDelegatedGrantResponse } | GrantsApiError> => {
      try {
        const userId = await dependencies.resolveUserId(request);
        const { grantId } = request.params as { grantId: string };
        // RLS makes foreign grants invisible: revokeGrant throws not-active /
        // not-exists, indistinguishable from missing for the caller (404).
        const revoked = await dependencies.grants.revokeGrant(grantId, userId);
        // Ledger revocation is authoritative and remains committed even if the
        // provider cannot remove its policy. The sync service records that
        // failure; a retry can clean up the provider policy later.
        await dependencies.policySync.syncRevocation(grantId, userId);
        const grant = (await dependencies.grants.getGrant(grantId, userId)) ?? revoked;
        const data = { grant: toGrantResponse(grant) };
        revokeDelegatedGrantResponseSchema.parse(data);
        return { ok: true, data };
      } catch (error) {
        if (error instanceof PrivyIdentityError) throw error;
        if (
          error instanceof Error &&
          /not active or does not exist/i.test(error.message)
        ) {
          return reply.code(404).send({
            ok: false,
            error: { code: "grant_no_encontrado", message: "Grant not found." },
          });
        }
        return reply.code(500).send({
          ok: false,
          error: { code: "ERROR_INTERNO", message: "Unexpected grants error." },
        });
      }
    },
  );
}
