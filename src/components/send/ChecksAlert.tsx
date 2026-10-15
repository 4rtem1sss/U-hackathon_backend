"use client";

import { ShieldAlert, ShieldQuestion } from "lucide-react";
import { EvidenceTag } from "@/components/common/EvidenceTag";
import { useT } from "@/web/i18n/LanguageProvider";
import { cn } from "@/web/utils";

export type ChecksBlock = "CHECKS_REJECTED" | "CHECKS_REVIEW_REQUIRED";

export function ChecksAlert({ code }: { code: ChecksBlock }) {
  const { t } = useT();
  const rejected = code === "CHECKS_REJECTED";
  const Icon = rejected ? ShieldAlert : ShieldQuestion;
  return (
    <div
      role="alert"
      className={cn(
        "mt-6 flex items-start gap-3 rounded-xl border p-4 text-sm",
        rejected ? "border-destructive/40 text-destructive" : "border-pending/40 text-pending",
      )}
    >
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <p className="flex-1">{t(`checks.${code}` as const)}</p>
      <EvidenceTag tag="SIMULATED" />
    </div>
  );
}
