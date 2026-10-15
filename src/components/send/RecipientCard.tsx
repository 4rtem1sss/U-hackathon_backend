"use client";

import { useRef, useState } from "react";
import { RecipientForm } from "@/components/send/RecipientForm";
import { Button } from "@/components/ui/button";
import type { Recipient } from "@/web/api/types";
import { initials, maskAccount } from "@/web/format";
import { useT } from "@/web/i18n/LanguageProvider";

type Props = { recipient: Recipient | null; failed: boolean; onChange(r: Recipient): void };

export function RecipientCard({ recipient, failed, onChange }: Props) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const changeRef = useRef<HTMLButtonElement>(null);

  function close() {
    setEditing(false);
    // Return focus after the card re-renders with the button.
    requestAnimationFrame(() => changeRef.current?.focus());
  }

  return (
    <div>
      <p className="text-sm font-medium text-muted-foreground">{t("send.recipientLabel")}</p>
      {editing ? (
        <RecipientForm onCancel={close} onSaved={(r) => { onChange(r); close(); }} />
      ) : (
        <div className="mt-2 flex items-center gap-4 rounded-xl border bg-background p-4">
          <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-full bg-secondary font-semibold text-brand">
            {recipient ? initials(recipient.name) : ""}
          </span>
          {recipient ? (
            <>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{recipient.name}</p>
                <p className="text-sm text-muted-foreground">
                  {recipient.bankLabel} · {maskAccount(recipient.accountDisplay)}
                </p>
              </div>
              <Button ref={changeRef} type="button" variant="outline" onClick={() => setEditing(true)}>
                {t("recipient.change")}
              </Button>
            </>
          ) : failed ? (
            <p className="text-sm text-destructive">{t("error.recipients")}</p>
          ) : (
            <div role="status" aria-label={t("common.loading")} className="h-10 w-48 animate-pulse rounded bg-muted" />
          )}
        </div>
      )}
    </div>
  );
}
