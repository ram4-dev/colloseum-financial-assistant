import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { registerGrantsRoutes } from "../../src/api/grants.js";
import { PrivyIdentityError } from "../../src/auth/privy-identity.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { DelegatedGrantService } from "../../src/wallet/grants/consumption.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("delegated grants HTTP lifecycle (DGC-5)", () => {
  let database: DatabaseClient;
  let service: DelegatedGrantService;
  let userAId: string;
  let userBId: string;
  let walletAId: string;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    service = new DelegatedGrantService(database);
    userAId = await provisionUser(database, "dgc-http-a");
    userBId = await provisionUser(database, "dgc-http-b");
    walletAId = await provisionWallet(database, userAId);
  });

  afterAll(async () => {
    await database.close();
  });

  function createApp() {
    const app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof PrivyIdentityError) {
        return reply.code(401).send({
          ok: false,
          error: { code: "no_autenticado", message: error.message },
        });
      }
      throw error;
    });
    void app.register(registerGrantsRoutes, {
      grants: service,
      resolveUserId: async (request) => {
        const token = request.headers.authorization;
        if (token === "Bearer user-a") return userAId;
        if (token === "Bearer user-b") return userBId;
        throw new PrivyIdentityError("unauthenticated", "Missing bearer token.");
      },
    });
    return app;
  }

  function validCreateBody() {
    return {
      walletId: walletAId,
      action: "transfer",
      chain: "solana",
      maxPerTransfer: "1000000",
      maxCumulative: "5000000",
      windowSeconds: 3600,
      recipients: [RECIPIENT],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }

  it("requires authentication: no token → 401 and no grant state change", async () => {
    const app = createApp();
    try {
      const response = await app.inject({ method: "POST", url: "/v1/grants" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("creates a grant via authenticated POST /v1/grants", async () => {
    const app = createApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/grants",
        headers: { authorization: "Bearer user-a" },
        payload: validCreateBody(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data.grant.state).toBe("active");
      expect(body.data.grant.policyReady).toBe(false);
      expect(body.data.grant.maxPerTransfer).toBe("1000000");
    } finally {
      await app.close();
    }
  });

  it("rejects a request body with unknown fields (strict schema)", async () => {
    const app = createApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/grants",
        headers: { authorization: "Bearer user-a" },
        payload: { ...validCreateBody(), dryRun: true },
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects a grant without expiration", async () => {
    const app = createApp();
    try {
      const body = validCreateBody();
      delete (body as Record<string, unknown>).expiresAt;
      const response = await app.inject({
        method: "POST",
        url: "/v1/grants",
        headers: { authorization: "Bearer user-a" },
        payload: body,
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("lists only the caller's grants (cross-user isolation)", async () => {
    const app = createApp();
    try {
      await app.inject({
        method: "POST",
        url: "/v1/grants",
        headers: { authorization: "Bearer user-a" },
        payload: validCreateBody(),
      });
      const forB = await app.inject({
        method: "GET",
        url: "/v1/grants",
        headers: { authorization: "Bearer user-b" },
      });
      expect(forB.statusCode).toBe(200);
      const body = forB.json();
      expect(body.ok).toBe(true);
      expect(body.data.grants).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("revokes a grant; the revoked grant no longer appears active", async () => {
    const app = createApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/v1/grants",
        headers: { authorization: "Bearer user-a" },
        payload: validCreateBody(),
      });
      const grantId = created.json().data.grant.id as string;

      const revoked = await app.inject({
        method: "POST",
        url: `/v1/grants/${grantId}/revoke`,
        headers: { authorization: "Bearer user-a" },
      });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json().data.grant.state).toBe("revoked");

      const listed = await app.inject({
        method: "GET",
        url: "/v1/grants",
        headers: { authorization: "Bearer user-a" },
      });
      const grant = listed
        .json()
        .data.grants.find((g: { id: string }) => g.id === grantId);
      expect(grant.state).toBe("revoked");
    } finally {
      await app.close();
    }
  });

  it("user B cannot revoke user A's grant (foreign id is 404, not 403)", async () => {
    const app = createApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/v1/grants",
        headers: { authorization: "Bearer user-a" },
        payload: validCreateBody(),
      });
      const grantId = created.json().data.grant.id as string;

      const revoked = await app.inject({
        method: "POST",
        url: `/v1/grants/${grantId}/revoke`,
        headers: { authorization: "Bearer user-b" },
      });
      expect(revoked.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

async function provisionUser(database: DatabaseClient, suffix: string): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO users (privy_did, display_name)
     VALUES ($1, $2) RETURNING id`,
    [`did:privy:${suffix}-${randomUUID()}`, "DGC HTTP"],
  );
  return result.rows[0]!.id;
}

async function provisionWallet(database: DatabaseClient, userId: string): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
     VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
    [userId, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
  );
  return result.rows[0]!.id;
}

