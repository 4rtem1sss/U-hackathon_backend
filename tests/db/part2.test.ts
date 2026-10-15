import { afterAll, beforeAll, expect, it } from "vitest";
import { CONSTRAINTS, isUniqueViolation } from "@/db/errors";
import { insertQuoteCheck } from "@/db/repos/quoteChecks";
import { insertQuote, type NewQuote } from "@/db/repos/quotes";
import { getRecipient, insertRecipient, listRecipients } from "@/db/repos/recipients";
import { findActiveSessionByTokenHash, insertDemoSession } from "@/db/repos/sessions";
import type { QuoteCheckResult, RecipientRow } from "@/db/types";
import { newId } from "@/lib/ids";
import { createMigratedDb, describeDb, newOwner, seedQuote, type TestDb } from "./helpers";

async function pgError(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; constraint?: string };
  }
  throw new Error("expected the query to fail");
}

const FK_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

describeDb("part 2 schema: sessions, recipients, quote checks", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createMigratedDb();
  });
  afterAll(async () => {
    await db?.drop();
  });

  const newRecipient = (ownerId: string) =>
    insertRecipient(db.pool, {
      id: newId("rcp"),
      ownerId,
      name: "Demo Recipient",
      bankLabel: "Demo Thai Bank",
      accountDisplay: "TEST ACCOUNT 0001",
    });

  const newCheck = (ownerId: string, recipientId: string, result: QuoteCheckResult) =>
    insertQuoteCheck(db.pool, {
      id: newId("chk"),
      ownerId,
      recipientId,
      sourceDebitMinor: 1000n,
      scenario: result,
      result,
      fixtureVersion: "fixture-us-th-v1",
    });

  const quoteInput = (ownerId: string, recipient: RecipientRow): NewQuote => ({
    id: newId("qt"),
    ownerId,
    recipientId: recipient.id,
    recipientSnapshot: {
      id: recipient.id,
      name: recipient.name,
      bankLabel: recipient.bankLabel,
      accountDisplay: recipient.accountDisplay,
      isSynthetic: true,
    },
    sourceCountry: "US",
    destinationCountry: "TH",
    sourceCurrency: "USD",
    destinationCurrency: "THB",
    sourceDebitMinor: 1000n,
    feeMinor: "20",
    conversionPrincipalMinor: "980",
    fxRateNumerator: "35",
    fxRateDenominator: "1",
    destinationNetMinor: "34300",
    settlementTokenUnits: "9800000",
    fixtureVersion: "fixture-us-th-v1",
    chainId: 43113,
    expiresAt: new Date(Date.now() + 300_000),
  });

  /** Raw quote insert so tests can set values insertQuote's types forbid. */
  function rawQuote(
    ownerId: string,
    recipient: RecipientRow,
    v: { checkId: string | null; checkResult: string | null; fee?: string; principal?: string },
  ) {
    return db.pool.query(
      `INSERT INTO quotes (
         id, owner_id, recipient_id, recipient_snapshot, source_country, destination_country,
         source_currency, destination_currency, source_debit_minor, fee_minor,
         conversion_principal_minor, fx_rate_numerator, fx_rate_denominator,
         destination_net_minor, settlement_token_units, fixture_version, chain_id, expires_at,
         check_id, check_result)
       VALUES ($1,$2,$3,'{}','US','TH','USD','THB',1000,$4,$5,35,1,34300,9800000,
               'fixture-us-th-v1',43113, now() + interval '5 minutes',$6,$7)`,
      [newId("qt"), ownerId, recipient.id, v.fee ?? "20", v.principal ?? "980", v.checkId, v.checkResult],
    );
  }

  it("finds an active session by token hash and ignores an expired one", async () => {
    const hash = `hash_${newId("ses")}`;
    const s = await insertDemoSession(db.pool, { id: newId("ses"), tokenHash: hash, ownerId: newOwner(), ttlSeconds: 3600 });
    const found = await findActiveSessionByTokenHash(db.pool, hash);
    expect(found?.id).toBe(s.id);
    expect(found?.ownerId).toBe(s.ownerId);

    await db.pool.query("UPDATE demo_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [s.id]);
    expect(await findActiveSessionByTokenHash(db.pool, hash)).toBeNull();
  });

  it("rejects a duplicate session token hash", async () => {
    const hash = `hash_${newId("ses")}`;
    await insertDemoSession(db.pool, { id: newId("ses"), tokenHash: hash, ownerId: newOwner(), ttlSeconds: 60 });
    const err = await pgError(
      insertDemoSession(db.pool, { id: newId("ses"), tokenHash: hash, ownerId: newOwner(), ttlSeconds: 60 }),
    );
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("scopes recipients to their owner", async () => {
    const a = newOwner();
    const b = newOwner();
    const ra = await newRecipient(a);
    const rb = await newRecipient(b);

    expect((await listRecipients(db.pool, a)).map((r) => r.id)).toEqual([ra.id]);
    expect((await listRecipients(db.pool, b)).map((r) => r.id)).toEqual([rb.id]);
    expect((await getRecipient(db.pool, a, ra.id))?.id).toBe(ra.id);
    expect(await getRecipient(db.pool, b, ra.id)).toBeNull();
  });

  it("stores a quote that references the same owner's PASS check", async () => {
    const owner = newOwner();
    const recipient = await newRecipient(owner);
    const check = await newCheck(owner, recipient.id, "PASS");
    const quote = await insertQuote(db.pool, { ...quoteInput(owner, recipient), checkId: check.id, checkResult: "PASS" });
    expect(quote.checkId).toBe(check.id);
    expect(quote.checkResult).toBe("PASS");
  });

  it("rejects a quote on a REJECT check claiming PASS (FK)", async () => {
    const owner = newOwner();
    const recipient = await newRecipient(owner);
    const check = await newCheck(owner, recipient.id, "REJECT");
    const err = await pgError(
      insertQuote(db.pool, { ...quoteInput(owner, recipient), checkId: check.id, checkResult: "PASS" }),
    );
    expect(err.code).toBe(FK_VIOLATION);
  });

  it("rejects a quote claiming check_result REJECT (check constraint)", async () => {
    const owner = newOwner();
    const recipient = await newRecipient(owner);
    const check = await newCheck(owner, recipient.id, "REJECT");
    const err = await pgError(rawQuote(owner, recipient, { checkId: check.id, checkResult: "REJECT" }));
    expect(err.code).toBe(CHECK_VIOLATION);
    expect(err.constraint).toBe("quotes_check_result_pass_check");
  });

  it("rejects a quote that points at another owner's PASS check", async () => {
    const owner = newOwner();
    const other = newOwner();
    const recipient = await newRecipient(owner);
    const otherRecipient = await newRecipient(other);
    const check = await newCheck(other, otherRecipient.id, "PASS");
    const err = await pgError(
      insertQuote(db.pool, { ...quoteInput(owner, recipient), checkId: check.id, checkResult: "PASS" }),
    );
    expect(err.code).toBe(FK_VIOLATION);
  });

  it("allows only one quote per check", async () => {
    const owner = newOwner();
    const recipient = await newRecipient(owner);
    const check = await newCheck(owner, recipient.id, "PASS");
    await insertQuote(db.pool, { ...quoteInput(owner, recipient), checkId: check.id, checkResult: "PASS" });
    const err = await pgError(
      insertQuote(db.pool, { ...quoteInput(owner, recipient), checkId: check.id, checkResult: "PASS" }),
    );
    expect(isUniqueViolation(err, CONSTRAINTS.quotesCheckId)).toBe(true);
  });

  it("rejects check_id without check_result", async () => {
    const owner = newOwner();
    const recipient = await newRecipient(owner);
    const check = await newCheck(owner, recipient.id, "PASS");
    const err = await pgError(rawQuote(owner, recipient, { checkId: check.id, checkResult: null }));
    expect(err.code).toBe(CHECK_VIOLATION);
    expect(err.constraint).toBe("quotes_check_pair_check");
  });

  it("rejects fee + principal that does not equal the debit", async () => {
    const owner = newOwner();
    const recipient = await newRecipient(owner);
    const err = await pgError(
      rawQuote(owner, recipient, { checkId: null, checkResult: null, fee: "20", principal: "981" }),
    );
    expect(err.code).toBe(CHECK_VIOLATION);
    expect(err.constraint).toBe("quotes_amounts_sum_check");
  });

  it("still inserts a legacy quote with no check", async () => {
    const quote = await seedQuote(db.pool, newOwner());
    expect(quote.checkId).toBeNull();
    expect(quote.checkResult).toBeNull();
  });
});
