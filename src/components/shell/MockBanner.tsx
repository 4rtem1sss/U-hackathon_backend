"use client";

import { useApi } from "@/web/api/ApiProvider";
import { useT } from "@/web/i18n/LanguageProvider";

export function MockBanner() {
  const { modes } = useApi();
  const { t } = useT();
  if (!Object.values(modes).includes("mock")) return null;
  return (
    <div role="note" className="border-b border-dashed border-pending/50 bg-pending/10 px-4 py-2 text-center text-sm font-medium text-pending">
      {t("header.mockData")}
    </div>
  );
}
