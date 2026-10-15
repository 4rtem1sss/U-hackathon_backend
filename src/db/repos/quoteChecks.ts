import "server-only";
import { mapRow } from "../map";
import type { Queryable } from "../pool";
import type { AmountString, QuoteCheckResult, QuoteCheckRow } from "../types";

export interface NewQuoteCheck {
  id: string;
  ownerId: string;
  recipientId: string;
  sourceDebitMinor: AmountString | bigint;
  scenario: QuoteCheckResult;
  result: QuoteCheckResult;
  fixtureVersion: string;
}

export async function insertQuoteCheck(db: Queryable, c: NewQuoteCheck): Promise<QuoteCheckRow> {
  const { rows } = await db.query(
    `INSERT INTO quote_checks (
       id, owner_id, recipient_id, source_debit_minor, scenario, result, fixture_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      c.id,
      c.ownerId,
      c.recipientId,
      String(c.sourceDebitMinor),
      c.scenario,
      c.result,
      c.fixtureVersion,
    ],
  );
  return mapRow<QuoteCheckRow>(rows[0]);
}
