"use client";

import { Check, ExternalLink, Loader2, Pause, X } from "lucide-react";
import { EvidenceTag } from "@/components/common/EvidenceTag";
import type { TransferSnapshot } from "@/web/api/types";
import { formatDateTime, shortHash } from "@/web/format";
import { useT } from "@/web/i18n/LanguageProvider";
import { stepTime, type StepState, type TransferView } from "@/web/status";
import { cn } from "@/web/utils";

function StepIcon({ state }: { state: StepState }) {
  const base = "relative z-10 grid size-10 shrink-0 place-items-center rounded-full border-2";
  switch (state) {
    case "done":
      return <span className={cn(base, "border-brand bg-brand text-white")}><Check className="draw-check size-5" aria-hidden /></span>;
    case "active":
      return <span className={cn(base, "border-brand bg-card text-brand")}><Loader2 className="size-5 animate-spin" aria-hidden /></span>;
    case "failed":
      return <span className={cn(base, "border-destructive bg-destructive text-white")}><X className="size-5" aria-hidden /></span>;
    case "hold":
      return <span className={cn(base, "border-pending bg-card text-pending")}><Pause className="size-5" aria-hidden /></span>;
    default:
      return <span className={cn(base, "border-border bg-card")} aria-hidden />;
  }
}

function SettlementEvidence({ snapshot }: { snapshot: TransferSnapshot }) {
  const { t } = useT();
  const { txHash, explorerUrl, mode } = snapshot.settlement;
  if (!txHash) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm animate-in fade-in duration-300">
      <code className="font-mono text-muted-foreground">{shortHash(txHash)}</code>
      {mode === "TESTNET" && explorerUrl && (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium text-brand underline-offset-4 hover:underline"
        >
          {t("track.viewExplorer")}
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      )}
    </div>
  );
}

export function Timeline({ view, snapshot, className }: { view: TransferView; snapshot: TransferSnapshot; className?: string }) {
  const { t, lang } = useT();
  return (
    <ol className={cn("relative", className)}>
      {view.steps.map((step, i) => {
        const last = i === view.steps.length - 1;
        const time = step.state === "done" ? stepTime(snapshot, step.id) : null;
        return (
          <li key={step.id} className="relative flex gap-4 pb-8 last:pb-0">
            {!last && (
              <span aria-hidden className="connector absolute bottom-1 left-5 top-11 w-0.5 -translate-x-1/2 bg-border">
                <span
                  className={cn(
                    "block h-full w-full origin-top bg-brand transition-transform duration-300 ease-out",
                    step.state === "done" ? "scale-y-100" : "scale-y-0",
                  )}
                />
                {step.id === "settlement" && step.state === "active" && (
                  <span className="absolute -inset-x-2 inset-y-0 overflow-hidden">
                    <span className="token-travel absolute inset-x-0 top-0 h-full">
                      <span className="absolute bottom-0 left-1/2 size-2.5 -translate-x-1/2 rounded-full bg-primary ring-2 ring-brand" />
                    </span>
                  </span>
                )}
              </span>
            )}
            <StepIcon state={step.state} />
            <div className="min-w-0 flex-1 pt-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn("font-semibold", step.state === "todo" && "text-muted-foreground")}>{t(step.labelKey)}</span>
                <EvidenceTag tag={step.tag} />
                <span className="sr-only">{t(`state.${step.state}` as const)}</span>
              </div>
              {time && <p className="mt-1 text-sm text-muted-foreground">{formatDateTime(time, lang)}</p>}
              {step.id === "settlement" && <SettlementEvidence snapshot={snapshot} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
