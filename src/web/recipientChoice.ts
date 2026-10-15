import type { Recipient } from "./api/types";

/** sessionStorage key for the recipient picked on page 1. */
export const RECIPIENT_KEY = "centme:recipientId";

/** The stored recipient if it still exists (new session or mock reset can drop it), else the first one. */
export function pickRecipient(list: Recipient[], storedId: string | null): Recipient | null {
  return list.find((r) => r.id === storedId) ?? list[0] ?? null;
}
