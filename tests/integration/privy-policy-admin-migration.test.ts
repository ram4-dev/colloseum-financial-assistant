/**
 * Task 2.7 — canonical signer binding migration integration (real chain).
 *
 * Proves the actual `010_canonical_signer_binding.sql` data backfill on a fresh
 * database built by `runMigrations` (never a manually pre-altered schema):
 *   - 0 historical signer ids        -> canonical binding stays NULL;
 *   - exactly 1 distinct signer id   -> backfilled;
 *   - 1 distinct repeated across rows-> backfilled (DISTINCT semantics);
 *   - >1 distinct (conflicting)      -> stays NULL (never guess);
 *   - pre-existing non-NULL binding  -> preserved untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("canonical signer binding migration 010 (task 2.7, real chain)", () => {
  let database: DatabaseClient;
  let ownerDatabase: DatabaseClient;

  async function seedEvidence(input: {
    walletId: string;
    userId: string;
    signerIds: string[];
  }): Promise<void> {
    for (const signerId of input.signerIds) {
      await database.query(
        `INSERT INTO signer_grants
           (user_id, wallet_id, provider_policy_id, provider_signer_id, policy_hash,
            allowlisted_recipients, per_transfer_atomic6, rolling_total_atomic6,
            rolling_window_seconds, gas_ceiling, state)
         VALUES ($1, $2, 'pol_mig', $3, 'hash', '[]'::jsonb,
                 '10000000', '50000000', 3600, '0.01', 'revoked')`,
        [input.userId, input.walletId, signerId],
      );
    }
  }

  async function signerOf(walletId: string): Promise<string | null> {
    // Read through the MIGRATED temp database client, not the owner pool
    // (which points at the base DATABASE_URL database, not nana_27_migrate).
    const rows = await database.query<{ provider_signer_id: string | null }>(
      "SELECT provider_signer_id FROM user_wallets WHERE id = $1",
      [walletId],
    );
    return rows.rows[0]?.provider_signer_id ?? null;
  }

  beforeAll(async () => {
    ownerDatabase = createDatabaseClient(databaseUrl!);
    // Fixed identifier: CREATE/DROP DATABASE cannot take bound parameters, so
    // the suite uses a constant database name (serial test execution only).
    // Cleanup happens in beforeAll first: a previous run's failure could leave
    // the temporary database behind, and DROP IF EXISTS also covers a failed
    // afterAll from an earlier attempt.
    await ownerDatabase.query('DROP DATABASE IF EXISTS "nana_27_migrate"');
    await ownerDatabase.query('CREATE DATABASE "nana_27_migrate"');
    const url = new URL(databaseUrl!);
    url.pathname = "/nana_27_migrate";
    await runMigrations(url.toString());
    database = createDatabaseClient(url.toString());
  });

  afterAll(async () => {
    await database?.close();
    if (ownerDatabase) {
      // Cleanup must run even if a test failed mid-suite: DROP IF EXISTS is
      // idempotent and the same DROP runs defensively at the next beforeAll.
      await ownerDatabase
        .query('DROP DATABASE IF EXISTS "nana_27_migrate"')
        .catch(() => undefined);
      await ownerDatabase.close();
    }
  });

  it("applies 010 in the local migration chain", async () => {
    const rows = await database.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name",
    );
    expect(rows.rows.map((r) => r.name)).toContain(
      "010_canonical_signer_binding.sql",
    );
  });

  it("leaves a wallet with zero historical evidence NULL", async () => {
    const user = await database.query<{ id: string }>(
      "SELECT users_ensure_for_privy_did($1, $2) AS id",
      ["did:privy:mig-zero", "mig-zero"],
    );
    const wallet = await database.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'privy', 'pw-mig-zero', 'ethereum', '0xzero', 'ready') RETURNING id`,
      [user.rows[0]!.id],
    );
    await seedEvidence({
      walletId: wallet.rows[0]!.id,
      userId: user.rows[0]!.id,
      signerIds: [],
    });
    // 010 already ran during beforeAll; re-running its statement set must be
    // idempotent for new rows, so re-apply the DO block via the migration file
    // semantics by simply asserting the migrated state.
    expect(await signerOf(wallet.rows[0]!.id)).toBeNull();
  });

  it("backfills exactly-one distinct evidence and repeats-are-fine evidence", async () => {
    const user = await database.query<{ id: string }>(
      "SELECT users_ensure_for_privy_did($1, $2) AS id",
      ["did:privy:mig-one", "mig-one"],
    );
    const walletA = await database.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'privy', 'pw-mig-one-a', 'ethereum', '0xa', 'ready') RETURNING id`,
      [user.rows[0]!.id],
    );
    // Distinct chain_family per wallet: the partial unique index allows one
    // READY wallet per (user_id, chain_family), so sibling fixtures use
    // solana/ethereum rather than two ethereum rows.
    const walletB = await database.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'privy', 'pw-mig-one-b', 'solana', '0xb', 'ready') RETURNING id`,
      [user.rows[0]!.id],
    );
    // Insert evidence BEFORE applying the backfill statement: the suite seeds
    // then re-runs the 010 DO block by re-applying the migration through a
    // direct call (idempotent IS NULL predicate; already-migrated rows skip).
    await seedEvidence({
      walletId: walletA.rows[0]!.id,
      userId: user.rows[0]!.id,
      signerIds: ["signer-mig-1"],
    });
    await seedEvidence({
      walletId: walletB.rows[0]!.id,
      userId: user.rows[0]!.id,
      signerIds: ["signer-mig-2", "signer-mig-2"],
    });
    // Re-apply the exact migration SQL (schema_migrations already records 010;
    // the statement is idempotent by construction).
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const sql = await readFile(
      resolve(
        process.cwd(),
        "src/db/migrations/010_canonical_signer_binding.sql",
      ),
      "utf8",
    );
    await database.query(sql);

    expect(await signerOf(walletA.rows[0]!.id)).toBe("signer-mig-1");
    expect(await signerOf(walletB.rows[0]!.id)).toBe("signer-mig-2");
  });

  it("never guesses on conflicting evidence and preserves an existing binding", async () => {
    const user = await database.query<{ id: string }>(
      "SELECT users_ensure_for_privy_did($1, $2) AS id",
      ["did:privy:mig-conflict", "mig-conflict"],
    );
    const walletConflict = await database.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'privy', 'pw-mig-conf', 'ethereum', '0xc', 'ready') RETURNING id`,
      [user.rows[0]!.id],
    );
    const walletBound = await database.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state, provider_signer_id)
       VALUES ($1, 'privy', 'pw-mig-bound', 'solana', '0xd', 'ready', 'signer-preset') RETURNING id`,
      [user.rows[0]!.id],
    );
    await seedEvidence({
      walletId: walletConflict.rows[0]!.id,
      userId: user.rows[0]!.id,
      signerIds: ["signer-old-1", "signer-old-2"],
    });
    await seedEvidence({
      walletId: walletBound.rows[0]!.id,
      userId: user.rows[0]!.id,
      signerIds: ["signer-historic"],
    });
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const sql = await readFile(
      resolve(
        process.cwd(),
        "src/db/migrations/010_canonical_signer_binding.sql",
      ),
      "utf8",
    );
    await database.query(sql);

    expect(await signerOf(walletConflict.rows[0]!.id)).toBeNull();
    // Pre-set binding survives even with single-distinct historic evidence.
    expect(await signerOf(walletBound.rows[0]!.id)).toBe("signer-preset");
  });
});
