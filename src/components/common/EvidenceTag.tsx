"use client";

import { useT } from "@/web/i18n/LanguageProvider";
import type { EvidenceTagKind } from "@/web/status";
import { cn } from "@/web/utils";

const STYLE: Record<EvidenceTagKind, string> = {
  SIMULATED: "border-dashed border-muted-foreground/60 text-muted-foreground",
  TESTNET: "border-solid border-brand text-brand",
  MOCK: "border-dashed border-pending text-pending",
};

export function EvidenceTag({ tag }: { tag: EvidenceTagKind }) {
  const { t } = useT();
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide", STYLE[tag])}>
      {t(`tag.${tag}` as const)}
    </span>
  );
}
