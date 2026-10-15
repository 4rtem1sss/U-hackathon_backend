#!/usr/bin/env node
// Tiny forward-only migration runner.
//
//   pnpm db:migrate          # applies db/migrations/*.sql in filename order
//   pnpm db:seed             # applies db/seed/*.sql (idempotent statements only)
//
// Each migration runs in its own transaction and is recorded in
// `schema_migrations` (name + sha256). A session-level advisory lock serialises
// concurrent runners. An applied file whose contents changed is an error:
// write a new migration instead of editing an old one.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MIGRATIONS_DIR = path.join(ROOT, "db", "migrations");
export const SEED_DIR = path.join(ROOT, "db", "seed");

// Arbitrary constant: pg_advisory_lock key for "schema migrations".
const LOCK_KEY = 727_001;

async function listSql(dir) {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(dir, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

/**
 * Apply pending migrations. Returns the names applied by this call.
 * @param {{ connectionString: string, dir?: string, log?: (msg: string) => void }} opts
 */
export async function runMigrations({ connectionString, dir = MIGRATIONS_DIR, log = () => {} }) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await client.query("ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY");
    const { rows } = await client.query("SELECT name, checksum FROM schema_migrations");
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const m of await listSql(dir)) {
      const prev = done.get(m.name);
      if (prev !== undefined) {
        if (prev !== m.checksum) {
          throw new Error(`migration ${m.name} was changed after it was applied (checksum mismatch)`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
          m.name,
          m.checksum,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${m.name} failed: ${err instanceof Error ? err.message : err}`, {
          cause: err,
        });
      }
      applied.push(m.name);
      log(`applied ${m.name}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return applied;
}

/**
 * Run every db/seed/*.sql file (each in a transaction). Seeds must be idempotent.
 * @param {{ connectionString: string, dir?: string, log?: (msg: string) => void }} opts
 */
export async function runSeeds({ connectionString, dir = SEED_DIR, log = () => {} }) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const s of await listSql(dir)) {
      await client.query("BEGIN");
      try {
        await client.query(s.sql);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      log(`seeded ${s.name}`);
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("migrate: DATABASE_URL is not set");
    process.exit(1);
  }
  const cmd = process.argv[2] ?? "up";
  const log = (msg) => console.log(`migrate: ${msg}`);
  if (cmd === "up") {
    const applied = await runMigrations({ connectionString, log });
    if (applied.length === 0) log("up to date");
  } else if (cmd === "seed") {
    await runSeeds({ connectionString, log });
  } else {
    console.error("usage: migrate.mjs [up|seed]");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // Only the message: never print the connection string.
    console.error(`migrate: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
