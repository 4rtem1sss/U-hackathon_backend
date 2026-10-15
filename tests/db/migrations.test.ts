import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runMigrations } from "../../scripts/migrate.mjs";
import { createEmptyDb, describeDb } from "./helpers";

const MIGRATIONS = ["0001_init.sql", "0002_notification.sql"];

const TABLES = [
  "demo_sessions",
  "recipients",
  "quotes",
  "transfers",
  "idempotency_keys",
  "transfer_events",
  "funding_attempts",
  "settlement_attempts",
  "payout_attempts",
  "schema_migrations",
];

describeDb("migrations", () => {
  let db: Awaited<ReturnType<typeof createEmptyDb>>;

  beforeAll(async () => {
    db = await createEmptyDb();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("apply on a clean database, then are a no-op on re-run (also when run concurrently)", async () => {
    const first = await runMigrations({ connectionString: db.url });
    expect(first).toEqual(MIGRATIONS);

    const again = await runMigrations({ connectionString: db.url });
    expect(again).toEqual([]);

    const parallel = await Promise.all([
      runMigrations({ connectionString: db.url }),
      runMigrations({ connectionString: db.url }),
    ]);
    expect(parallel).toEqual([[], []]);
  });

  it("creates every table with RLS enabled and no policies", async () => {
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      const { rows } = await c.query<{ relname: string; relrowsecurity: boolean }>(
        `SELECT relname, relrowsecurity FROM pg_class
          WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`,
      );
      const byName = new Map(rows.map((r) => [r.relname, r.relrowsecurity]));
      for (const t of TABLES) expect(byName.get(t), t).toBe(true);

      const policies = await c.query("SELECT 1 FROM pg_policies WHERE schemaname = 'public'");
      expect(policies.rowCount).toBe(0);

      const { rows: mig } = await c.query("SELECT name FROM schema_migrations");
      expect(mig.map((r) => r.name).sort()).toEqual(MIGRATIONS);
    } finally {
      await c.end();
    }
  });
});

describeDb("migrations: concurrent first run", () => {
  let db: Awaited<ReturnType<typeof createEmptyDb>>;
  beforeAll(async () => {
    db = await createEmptyDb();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("two runners racing on a clean database apply each migration exactly once", async () => {
    const results = await Promise.all([
      runMigrations({ connectionString: db.url }),
      runMigrations({ connectionString: db.url }),
    ]);
    expect(results.flat().sort()).toEqual(MIGRATIONS);
  });
});
