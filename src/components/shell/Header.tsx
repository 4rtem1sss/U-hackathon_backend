"use client";

import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { useT } from "@/web/i18n/LanguageProvider";

export function Header() {
  const { t, lang, setLang } = useT();
  return (
    <header className="border-b bg-card">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
      >
        {t("header.skip")}
      </a>
      <div className="mx-auto flex h-16 w-full max-w-[1040px] items-center justify-between px-4 sm:px-6">
        <Link href="/" className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
          <Logo />
        </Link>
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-highlight px-3 py-1 text-xs font-semibold uppercase tracking-wide text-foreground">
            {t("header.testMode")}
          </span>
          <Button variant="ghost" onClick={() => setLang(lang === "en" ? "th" : "en")} aria-label={t("header.langAria")}>
            {t("header.langToggle")}
          </Button>
        </div>
      </div>
    </header>
  );
}
