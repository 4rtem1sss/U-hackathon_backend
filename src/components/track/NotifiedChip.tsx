"use client";

import { Smartphone } from "lucide-react";
import { useT } from "@/web/i18n/LanguageProvider";

export function NotifiedChip() {
  const { t } = useT();
  return (
    <span role="status" className="inline-flex items-center gap-2 rounded-full bg-primary/40 px-3 py-1.5 text-sm font-medium text-foreground animate-in fade-in zoom-in-95 duration-200">
      <Smartphone className="size-4" aria-hidden />
      {t("track.notified")}
    </span>
  );
}
