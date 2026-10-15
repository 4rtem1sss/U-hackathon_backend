"use client";

import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { Flag } from "@/components/shell/Flag";
import { Button } from "@/components/ui/button";
import { useApi } from "@/web/api/ApiProvider";
import { useT } from "@/web/i18n/LanguageProvider";
import { cn } from "@/web/utils";

export function Header() {
  const { t, lang, setLang } = useT();
  const { modes } = useApi();
  // Settlement runs in the transfers group, so that flag decides what the pill claims.
  const onFuji = modes.transfers === "real";
  const status = onFuji ? t("header.fuji") : t("header.mock");
  return (
    <header className="border-b bg-card">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
      >
        {t("header.skip")}
      </a>
      <div className="mx-auto flex h-20 w-full max-w-[1040px] items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
          <Logo />
        </Link>
        <div className="flex items-center gap-3">
          <span className="inline-flex h-10 items-center gap-2 rounded-full bg-secondary px-3 text-sm font-medium text-foreground sm:px-4">
            <span aria-hidden className={cn("size-2 rounded-full", onFuji ? "bg-done" : "bg-pending")} />
            {/* Real text, visually hidden below 640px: aria-label on a plain span is not announced. */}
            <span className="sr-only sm:not-sr-only">{status}</span>
          </span>
          <Button
            variant="outline"
            className="h-10 gap-2 px-3 text-sm font-medium"
            onClick={() => setLang(lang === "en" ? "th" : "en")}
            aria-label={t("header.langAria")}
          >
            <Flag country={lang === "en" ? "TH" : "US"} />
            <span aria-hidden>{t("header.langCode")}</span>
          </Button>
        </div>
      </div>
    </header>
  );
}
