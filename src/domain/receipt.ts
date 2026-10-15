import { ID_PREFIX, newId } from "@/lib/ids";

export const RECEIPT_SUMMARY = "Demo completed: testnet settlement confirmed; THB payout simulated.";

/** Demo receipt (api-contract section 6). Amounts/evidence stay in the surrounding snapshot. */
export interface Receipt {
  id: string;
  issuedAt: Date;
  summary: string;
}

export function buildReceipt(now: Date, id: string = newId(ID_PREFIX.receipt)): Receipt {
  return { id, issuedAt: new Date(now.getTime()), summary: RECEIPT_SUMMARY };
}
