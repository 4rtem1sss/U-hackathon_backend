"use client";

import type { Recipient } from "@/web/api/types";
import { initials, maskAccount } from "@/web/format";
import { useT } from "@/web/i18n/LanguageProvider";

export function RecipientCard({ recipient, failed }: { recipient: Recipient | null; failed: boolean }) {
  const { t } = useT();
  return (
    <div>
      <p className="text-sm font-medium text-muted-foreground">{t("send.recipientLabel")}</p>
      <div className="mt-2 flex items-center gap-4 rounded-xl border bg-background p-4">
        <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-full bg-secondary font-semibold text-brand">
          {recipient ? initials(recipient.name) : ""}
        </span>
        {recipient ? (
          <div className="min-w-0">
            <p className="font-semibold">{recipient.name}</p>
            <p className="text-sm text-muted-foreground">
              {recipient.bankLabel} · {maskAccount(recipient.accountDisplay)}
            </p>
          </div>
        ) : failed ? (
          <p className="text-sm text-destructive">{t("error.recipients")}</p>
        ) : (
          <div role="status" aria-label={t("common.loading")} className="h-10 w-48 animate-pulse rounded bg-muted" />
        )}
      </div>
    </div>
  );
}
