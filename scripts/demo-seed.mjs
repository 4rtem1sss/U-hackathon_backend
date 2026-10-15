#!/usr/bin/env node
// Seeds one demo session + synthetic Thai recipient + an OPEN USD 10.00 quote
// (fixture-us-th-v1) so the transfer flow can be tried before part 2's
// session/quote endpoints exist. Prints shell exports for scripts/demo-flow.sh.
// Usage: DATABASE_URL=... node scripts/demo-seed.mjs
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const token = randomBytes(24).toString("hex");
const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
const ownerId = `own_${randomUUID()}`;
const sessionId = `ses_${randomUUID()}`;
const recipientId = `rcp_${randomUUID()}`;
const quoteId = `quo_${randomUUID()}`;
const recipient = {
  id: recipientId,
  name: "Demo Recipient",
  country: "TH",
  currency: "THB",
  bankLabel: "Demo Thai Bank",
  accountDisplay: "TEST ACCOUNT 0001",
  isSynthetic: true,
};

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(
    "INSERT INTO demo_sessions (id, token_hash, owner_id, expires_at) VALUES ($1, $2, $3, now() + interval '24 hours')",
    [sessionId, tokenHash, ownerId],
  );
  await client.query(
    "INSERT INTO recipients (id, owner_id, name, bank_label, account_display) VALUES ($1, $2, $3, $4, $5)",
    [recipientId, ownerId, recipient.name, recipient.bankLabel, recipient.accountDisplay],
  );
  await client.query(
    `INSERT INTO quotes (id, owner_id, recipient_id, recipient_snapshot, source_country, destination_country,
       source_currency, destination_currency, source_debit_minor, fee_minor, conversion_principal_minor,
       fx_rate_numerator, fx_rate_denominator, destination_net_minor, settlement_token_units,
       fixture_version, chain_id, expires_at)
     VALUES ($1, $2, $3, $4, 'US', 'TH', 'USD', 'THB', 1000, 20, 980, 35, 1, 34300, 9800000,
       'fixture-us-th-v1', 43113, now() + interval '15 minutes')`,
    [quoteId, ownerId, recipientId, JSON.stringify(recipient)],
  );
  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  await client.end();
}

console.log(`export DEMO_COOKIE='demo_session=${token}'`);
console.log(`export DEMO_QUOTE_ID='${quoteId}'`);
