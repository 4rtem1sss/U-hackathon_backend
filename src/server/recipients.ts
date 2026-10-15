import "server-only";
import { getPool, listRecipients } from "@/db";
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

/** The session owner's recipients, public shape only (no ownerId/createdAt). */
export async function listSessionRecipients(req: Request): Promise<RecipientView[]> {
  const { ownerId } = await requireSession(req);
  const rows = await listRecipients(getPool(), ownerId);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    country: r.country,
    currency: r.currency,
    bankLabel: r.bankLabel,
    accountDisplay: r.accountDisplay,
    isSynthetic: r.isSynthetic,
  }));
}
