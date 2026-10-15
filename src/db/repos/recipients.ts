import "server-only";
import { mapRow } from "../map";
import type { Queryable } from "../pool";
import type { RecipientRow } from "../types";

export interface NewRecipient {
  id: string;
  ownerId: string;
  name: string;
  bankLabel: string;
  accountDisplay: string;
}

/** country, currency and is_synthetic use the column defaults (TH, THB, true). */
export async function insertRecipient(db: Queryable, r: NewRecipient): Promise<RecipientRow> {
  const { rows } = await db.query(
    `INSERT INTO recipients (id, owner_id, name, bank_label, account_display)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [r.id, r.ownerId, r.name, r.bankLabel, r.accountDisplay],
  );
  return mapRow<RecipientRow>(rows[0]);
}

export async function listRecipients(db: Queryable, ownerId: string): Promise<RecipientRow[]> {
  const { rows } = await db.query(
    "SELECT * FROM recipients WHERE owner_id = $1 ORDER BY created_at, id",
    [ownerId],
  );
  return rows.map((row) => mapRow<RecipientRow>(row));
}

/** Owner-scoped: null for a missing recipient or another owner's. */
export async function getRecipient(
  db: Queryable,
  ownerId: string,
  id: string,
): Promise<RecipientRow | null> {
  const { rows } = await db.query("SELECT * FROM recipients WHERE id = $1 AND owner_id = $2", [
    id,
    ownerId,
  ]);
  return rows[0] ? mapRow<RecipientRow>(rows[0]) : null;
}
