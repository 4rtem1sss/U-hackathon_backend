"use client";

import { Check, ExternalLink, Link2 } from "lucide-react";
import { toast } from "sonner";
import { SummaryRow } from "@/components/common/SummaryRow";
import { Button } from "@/components/ui/button";
import type { TransferSnapshot } from "@/web/api/types";
import { formatDateTime, maskAccount, shortHash } from "@/web/format";
import { useT } from "@/web/i18n/LanguageProvider";
import { formatMinor, formatRate, formatTokenUnits } from "@/web/money";

export function Receipt({ snapshot: s, onSendAnother }: { snapshot: TransferSnapshot; onSendAnother(): void }) {
  const { t, lang } = useT();
  if (!s.receipt) return null;
  const a = s.amounts;
  const received = a.destinationNetMinor;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success(t("action.copied"));
    } catch {
      toast(window.location.href);
    }
  }

  return (
    <section
      aria-labelledby="receipt-title"
      className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8 animate-in fade-in slide-in-from-bottom-4 duration-300"
    >
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-full bg-primary">
          <Check className="size-5 text-foreground" aria-hidden />
        </span>
        <h2 id="receipt-title" className="text-lg font-semibold">{t("receipt.title")}</h2>
      </div>

      <p className="mt-4 text-sm text-muted-foreground">{t("receipt.theyReceived")}</p>
      <p className="tabular text-4xl font-semibold tracking-tight text-brand">{formatMinor(received, "THB", lang)}</p>
      <p className="mt-2 text-sm font-medium">{t("receipt.summary")}</p>
      {/* Server evidence, verbatim and English only (spec section 2). */}
      <p lang="en" className="mt-1 text-xs text-muted-foreground">{s.receipt.summary}</p>

      <dl className="mt-6 space-y-3 border-t pt-6 text-sm">
        <SummaryRow label={t("receipt.youSent")} value={formatMinor(a.sourceDebitMinor, "USD", lang)} strong />
        <SummaryRow label={t("send.fee")} value={formatMinor(a.feeMinor, "USD", lang)} />
        <SummaryRow label={t("send.rate")} value={formatRate(s.fx.rateNumerator, s.fx.rateDenominator, lang)} />
        <SummaryRow label={t("receipt.usdc")} value={formatTokenUnits(a.settlementTokenUnits, s.settlement.tokenDecimals)} />
        <SummaryRow
          label={t("receipt.recipient")}
          value={`${s.recipient.name} · ${s.recipient.bankLabel} ${maskAccount(s.recipient.accountDisplay)}`}
        />
        <SummaryRow label={t("receipt.fundingRef")} value={s.funding.reference ?? "—"} />
        <SummaryRow label={t("receipt.payoutRef")} value={s.payout.reference ?? "—"} />
        <SummaryRow
          label={t("receipt.txHash")}
          value={
            s.settlement.txHash ? (
              <span className="inline-flex flex-wrap items-center justify-end gap-2">
                <code className="font-mono">{shortHash(s.settlement.txHash)}</code>
                {s.settlement.mode === "TESTNET" && s.settlement.explorerUrl && (
                  <a href={s.settlement.explorerUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand underline-offset-4 hover:underline">
                    {t("track.viewExplorer")}
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                )}
              </span>
            ) : "—"
          }
        />
        <SummaryRow label={t("receipt.verifiedAt")} value={s.settlement.verifiedAt ? formatDateTime(s.settlement.verifiedAt, lang) : "—"} />
        <SummaryRow label={t("receipt.id")} value={<code className="font-mono">{s.receipt.id}</code>} />
        <SummaryRow label={t("receipt.issued")} value={formatDateTime(s.receipt.issuedAt, lang)} />
      </dl>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Button className="h-12 flex-1 text-base font-semibold" onClick={onSendAnother}>{t("action.SEND_ANOTHER")}</Button>
        <Button variant="outline" className="h-12 flex-1 text-base" onClick={() => void copyLink()}>
          <Link2 aria-hidden />
          {t("action.COPY_LINK")}
        </Button>
      </div>
    </section>
  );
}
