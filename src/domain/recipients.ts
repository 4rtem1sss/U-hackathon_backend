import { z } from "zod";

/** Banks offered in the demo recipient form. Labels are what the UI and receipts show. */
export const THAI_BANKS = [
  { code: "KBANK", label: "Kasikorn Bank" },
  { code: "SCB", label: "SCB" },
  { code: "BBL", label: "Bangkok Bank" },
  { code: "KTB", label: "Krungthai" },
  { code: "BAY", label: "Krungsri" },
  { code: "TTB", label: "ttb" },
  { code: "GSB", label: "GSB" },
] as const;

export type BankCode = (typeof THAI_BANKS)[number]["code"];

const BANK_CODES = THAI_BANKS.map((b) => b.code) as [BankCode, ...BankCode[]];

/** Per-session cap, the seeded demo recipient included. */
export const RECIPIENT_LIMIT = 10;

export function bankLabel(code: BankCode): string {
  return THAI_BANKS.find((b) => b.code === code)?.label ?? code;
}

export function normalizeAccountNumber(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

/** Only the last 4 digits are ever kept; someone may type a real account number on stage. */
export function accountDisplayFromNumber(digits: string): string {
  return `••${digits.slice(-4)}`;
}

/** `POST /api/recipients` body. Extra fields are rejected. */
export const newRecipientBody = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    // At least one letter: "-" or a lone tone mark is not a name.
    .regex(/^(?=.*\p{L})[\p{L}\p{M} .'-]+$/u),
  bankCode: z.enum(BANK_CODES),
  accountNumber: z
    .string()
    .max(40)
    .transform(normalizeAccountNumber)
    .pipe(z.string().regex(/^\d{10,12}$/)),
});
export type NewRecipientBody = z.infer<typeof newRecipientBody>;
