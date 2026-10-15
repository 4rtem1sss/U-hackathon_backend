"use client";

import { useT } from "@/web/i18n/LanguageProvider";

export function Footer() {
  const { t } = useT();
  return (
    <footer className="mx-auto w-full max-w-[1040px] px-4 pb-10 text-center text-sm text-muted-foreground sm:px-6">
      {t("footer.note")}
    </footer>
  );
}
