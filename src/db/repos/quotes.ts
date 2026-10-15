import "server-only";
import type pg from "pg";
import { jsonParam, mapRow } from "../map";
import type { Queryable } from "../pool";
import type { AmountString, QuoteRow, RecipientSnapshot } from "../types";

type AmountInput = AmountString | bigint;

/**
 * Quote creation belongs to part 2; this insert exists for tests and as a
 * reference for the column mapping.
 */
export interface NewQuote {
  id: string;
  ownerId: string;
  recipientId: string;
  recipientSnapshot: RecipientSnapshot;
  sourceCountry: string;
  destinationCountry: string;
  sourceCurrency: string;
  destinationCurrency: string;
  sourceDebitMinor: AmountInput;
  feeMinor: AmountInput;
  conversionPrincipalMinor: AmountInput;
  fxRateNumerator: AmountInput;
  fxRateDenominator: AmountInput;
  destinationNetMinor: AmountInput;
  settlementTokenUnits: AmountInput;
  fixtureVersion: string;
  chainId: number;
  expiresAt: Date;
}

export async function insertQuote(db: Queryable, q: NewQuote): Promise<QuoteRow> {
  const { rows } = await db.query(
    `INSERT INTO quotes (
       id, owner_id, recipient_id, recipient_snapshot, source_country, destination_country,
       source_currency, destination_currency, source_debit_minor, fee_minor,
       conversion_principal_minor, fx_rate_numerator, fx_rate_denominator,
       destination_net_minor, settlement_token_units, fixture_version, chain_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      q.id,
      q.ownerId,
      q.recipientId,
      jsonParam(q.recipientSnapshot),
      q.sourceCountry,
      q.destinationCountry,
      q.sourceCurrency,
      q.destinationCurrency,
      String(q.sourceDebitMinor),
      String(q.feeMinor),
      String(q.conversionPrincipalMinor),
      String(q.fxRateNumerator),
      String(q.fxRateDenominator),
      String(q.destinationNetMinor),
      String(q.settlementTokenUnits),
      q.fixtureVersion,
      q.chainId,
      q.expiresAt,
    ],
  );
  return mapRow<QuoteRow>(rows[0]);
}

/**
 * Lock a quote for acceptance, owner-scoped (null for missing or another
 * owner's quote). Expiry is not checked here: compare `expiresAt` with DB time
 * (or use `markQuoteAccepted`, which refuses expired quotes).
 */
export async function getQuoteForUpdate(
  client: pg.PoolClient,
  ownerId: string,
  id: string,
): Promise<QuoteRow | null> {
  const { rows } = await client.query(
    "SELECT * FROM quotes WHERE id = $1 AND owner_id = $2 FOR UPDATE",
    [id, ownerId],
  );
  return rows[0] ? mapRow<QuoteRow>(rows[0]) : null;
}

/**
 * OPEN -> ACCEPTED, only if not yet expired (by DB clock). Returns the updated
 * row, or null if the quote is not OPEN or has expired.
 */
export async function markQuoteAccepted(
  client: pg.PoolClient,
  id: string,
): Promise<QuoteRow | null> {
  const { rows } = await client.query(
    `UPDATE quotes SET status = 'ACCEPTED', accepted_at = now()
      WHERE id = $1 AND status = 'OPEN' AND expires_at > now()
      RETURNING *`,
    [id],
  );
  return rows[0] ? mapRow<QuoteRow>(rows[0]) : null;
}
