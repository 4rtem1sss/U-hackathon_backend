"use client";

import { ChevronDown } from "lucide-react";
import { SummaryRow } from "@/components/common/SummaryRow";
import type { TransferSnapshot } from "@/web/api/types";
import { formatDateTime } from "@/web/format";
import { useT } from "@/web/i18n/LanguageProvider";
import { cn } from "@/web/utils";

export function Details({ snapshot: s, className }: { snapshot: TransferSnapshot; className?: string }) {
  const { t, lang } = useT();
  const mock = s.settlement.mode === "MOCK";
  return (
    <details className={cn("group rounded-xl border bg-background", className)}>
      <summary className="flex cursor-pointer list-none items-center justify-between rounded-xl px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        {t("track.details")}
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <dl className="space-y-3 border-t px-4 py-4 text-sm">
        <SummaryRow label={t("detail.transferId")} value={<code className="font-mono break-all">{s.id}</code>} />
        <SummaryRow label={t("receipt.fundingRef")} value={s.funding.reference ?? "—"} />
        <SummaryRow label={t("receipt.payoutRef")} value={s.payout.reference ?? "—"} />
        <SummaryRow
          label={t("receipt.txHash")}
          value={s.settlement.txHash ? <code className="font-mono break-all">{s.settlement.txHash}</code> : "—"}
        />
        <SummaryRow label={t("detail.network")} value={mock ? t("detail.networkMock") : `Avalanche Fuji (${s.settlement.chainId})`} />
        <SummaryRow label={t("detail.token")} value={<code className="font-mono break-all">{s.settlement.tokenAddress}</code>} />
        <SummaryRow label={t("receipt.verifiedAt")} value={s.settlement.verifiedAt ? formatDateTime(s.settlement.verifiedAt, lang) : "—"} />
      </dl>
    </details>
  );
}
