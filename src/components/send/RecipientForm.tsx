"use client";

import { Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { newRecipientBody, THAI_BANKS, type BankCode } from "@/domain/recipients";
import { useApi } from "@/web/api/ApiProvider";
import { isApiError } from "@/web/api/errors";
import type { Recipient } from "@/web/api/types";
import { errorText } from "@/web/i18n/errorText";
import { useT } from "@/web/i18n/LanguageProvider";
import { cn } from "@/web/utils";

type Field = "name" | "bankCode" | "accountNumber";
const FIELDS: Field[] = ["name", "bankCode", "accountNumber"];

const inputClass = (invalid: boolean) =>
  cn(
    "mt-2 h-11 w-full rounded-lg border bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring",
    invalid && "border-destructive",
  );

export function RecipientForm({ onSaved, onCancel }: { onSaved(r: Recipient): void; onCancel(): void }) {
  const { api } = useApi();
  const { t } = useT();
  const [name, setName] = useState("");
  const [bankCode, setBankCode] = useState<BankCode | "">("");
  const [accountNumber, setAccountNumber] = useState("");
  const [errors, setErrors] = useState<Partial<Record<Field, true>>>({});
  const [saving, setSaving] = useState(false);
  // Enter can fire twice before `saving` re-renders; the ref blocks the second POST.
  const inFlight = useRef(false);
  const refs = { name: useRef<HTMLInputElement>(null), bankCode: useRef<HTMLSelectElement>(null), accountNumber: useRef<HTMLInputElement>(null) };

  function showErrors(fields: Field[]) {
    setErrors(Object.fromEntries(fields.map((f) => [f, true])));
    refs[fields[0]!]?.current?.focus();
  }

  async function onSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (inFlight.current) return;
    const input = { name, bankCode, accountNumber };
    const parsed = newRecipientBody.safeParse(input);
    if (!parsed.success) {
      showErrors(FIELDS.filter((f) => parsed.error.issues.some((i) => i.path[0] === f)));
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      onSaved(await api.createRecipient({ name, bankCode: parsed.data.bankCode, accountNumber }));
    } catch (err) {
      const bad = isApiError(err, "INVALID_INPUT") ? FIELDS.filter((f) => f in err.fieldErrors) : [];
      if (bad.length > 0) showErrors(bad);
      else toast.error(errorText(err, t));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  const err = (f: Field) =>
    errors[f] ? (
      <p id={`rcp-${f}-error`} className="mt-1 text-sm text-destructive">{t(`recipient.error.${f}` as const)}</p>
    ) : null;

  // Not a <form>: it sits inside the page's send <form>, and nested forms are invalid HTML.
  return (
    <div role="group" aria-labelledby="rcp-form-title" className="mt-2 rounded-xl border bg-background p-4"
      onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") void onSubmit(e); }}>
      <p id="rcp-form-title" className="font-semibold">{t("recipient.formTitle")}</p>
      <div className="mt-4 space-y-4">
        <div>
          <label htmlFor="rcp-name" className="text-sm font-medium text-muted-foreground">{t("recipient.name")}</label>
          <input id="rcp-name" ref={refs.name} value={name} autoComplete="off" maxLength={60}
            onChange={(e) => { setName(e.target.value); setErrors((x) => ({ ...x, name: undefined })); }}
            aria-invalid={!!errors.name} aria-describedby={errors.name ? "rcp-name-error" : undefined}
            className={inputClass(!!errors.name)} />
          {err("name")}
        </div>
        <div>
          <label htmlFor="rcp-bank" className="text-sm font-medium text-muted-foreground">{t("recipient.bank")}</label>
          <select id="rcp-bank" ref={refs.bankCode} value={bankCode}
            onChange={(e) => { setBankCode(e.target.value as BankCode); setErrors((x) => ({ ...x, bankCode: undefined })); }}
            aria-invalid={!!errors.bankCode} aria-describedby={errors.bankCode ? "rcp-bankCode-error" : undefined}
            className={inputClass(!!errors.bankCode)}>
            <option value="" disabled>{t("recipient.bankPlaceholder")}</option>
            {THAI_BANKS.map((b) => <option key={b.code} value={b.code}>{b.label}</option>)}
          </select>
          {err("bankCode")}
        </div>
        <div>
          <label htmlFor="rcp-account" className="text-sm font-medium text-muted-foreground">{t("recipient.account")}</label>
          <input id="rcp-account" ref={refs.accountNumber} value={accountNumber} inputMode="numeric" autoComplete="off" maxLength={20}
            onChange={(e) => { setAccountNumber(e.target.value); setErrors((x) => ({ ...x, accountNumber: undefined })); }}
            aria-invalid={!!errors.accountNumber}
            aria-describedby={errors.accountNumber ? "rcp-account-help rcp-accountNumber-error" : "rcp-account-help"}
            className={cn(inputClass(!!errors.accountNumber), "tabular")} />
          <p id="rcp-account-help" className="mt-1 text-sm text-muted-foreground">{t("recipient.accountHelp")}</p>
          {err("accountNumber")}
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>{t("recipient.cancel")}</Button>
        <Button type="button" onClick={(e) => void onSubmit(e)} disabled={saving}>
          {saving && <Loader2 className="animate-spin" aria-hidden />}
          {t("recipient.save")}
        </Button>
      </div>
    </div>
  );
}
