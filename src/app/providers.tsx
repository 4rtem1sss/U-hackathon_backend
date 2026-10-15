"use client";

import type { ReactNode } from "react";
import { ApiProvider } from "@/web/api/ApiProvider";
import { LanguageProvider } from "@/web/i18n/LanguageProvider";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <ApiProvider>{children}</ApiProvider>
    </LanguageProvider>
  );
}
