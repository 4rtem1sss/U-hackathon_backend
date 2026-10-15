import "server-only";
import { getPool, insertRecipient, listRecipients, withTransaction } from "@/db";
import type { RecipientRow } from "@/db/types";
import { accountDisplayFromNumber, bankLabel, RECIPIENT_LIMIT, type NewRecipientBody } from "@/domain/recipients";
import { ApiError } from "@/lib/errors";
import { ID_PREFIX, newId } from "@/lib/ids";
import { requireSession } from "./session";

export interface RecipientView {
  id: string;
  name: string;
  country: string;
  currency: string;
  bankLabel: string;
  accountDisplay: string;
  isSynthetic: boolean;
}

/** Public shape only (no ownerId/createdAt). */
function toView(r: RecipientRow): RecipientView {
  return {
    id: r.id,
    name: r.name,
    country: r.country,
    currency: r.currency,
    bankLabel: r.bankLabel,
    accountDisplay: r.accountDisplay,
    isSynthetic: r.isSynthetic,
  };
}

/** The session owner's recipients. */
export async function listSessionRecipients(req: Request): Promise<RecipientView[]> {
  const { ownerId } = await requireSession(req);
  const rows = await listRecipients(getPool(), ownerId);
  return rows.map(toView);
}

/**
 * Add a synthetic recipient typed in during the demo. Only the last 4 account
 * digits are stored. The advisory lock serializes one owner's requests so two
 * concurrent creates cannot both pass the cap.
 */
export async function createSessionRecipient(input: { ownerId: string; body: NewRecipientBody }): Promise<RecipientView> {
  const { ownerId, body } = input;
  const row = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [ownerId]);
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM recipients WHERE owner_id = $1",
      [ownerId],
    );
    if ((rows[0]?.n ?? 0) >= RECIPIENT_LIMIT) throw new ApiError("RECIPIENT_LIMIT");
    return insertRecipient(client, {
      id: newId(ID_PREFIX.recipient),
      ownerId,
      name: body.name,
      bankLabel: bankLabel(body.bankCode),
      accountDisplay: accountDisplayFromNumber(body.accountNumber),
    });
  });
  return toView(row);
}
