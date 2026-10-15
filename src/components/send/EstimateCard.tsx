"use client";

import { SummaryRow } from "@/components/common/SummaryRow";
import { useT } from "@/web/i18n/LanguageProvider";
import { FIXTURE, formatMinor, formatRate, type Estimate } from "@/web/money";

export function EstimateCard({ estimate }: { estimate: Estimate | null }) {
  const { t, lang } = useT();
  return (
    <aside aria-labelledby="estimate-title" className="rounded-2xl border bg-card p-6 shadow-sm lg:sticky lg:top-8">
      <div className="flex items-center justify-between gap-3">
        <h2 id="estimate-title" className="text-sm font-medium text-muted-foreground">{t("send.theyReceive")}</h2>
        <span className="rounded-full border border-dashed px-2 py-0.5 text-xs font-medium text-muted-foreground">{t("send.estimate")}</span>
      </div>
      <p className="tabular mt-2 text-4xl font-semibold tracking-tight text-brand">
        {estimate ? formatMinor(estimate.destinationNetMinor, "THB", lang) : "—"}
      </p>
      <dl className="mt-6 space-y-3 text-sm">
        <SummaryRow label={t("send.fee")} value={estimate ? formatMinor(estimate.feeMinor, "USD", lang) : "—"} />
        <SummaryRow label={t("send.rate")} value={formatRate(FIXTURE.rateNumerator.toString(), FIXTURE.rateDenominator.toString(), lang)} />
        <SummaryRow label={t("send.arrival")} value={t("send.timing")} />
      </dl>
    </aside>
  );
}
