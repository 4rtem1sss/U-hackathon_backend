"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ntfyNotifier } from "../notify";
import { browserStorage } from "../storage";
import type { ApiClient } from "./client";
import { createRoutedClient, endpointWarnings, parseRealEndpoints, type EndpointModes } from "./index";
import { createMockClient } from "./mock";
import { createRealClient } from "./real";

/** `resetCount` goes up on every mock reset so mounted pages can reload what the reset dropped. */
type ApiContextValue = { api: ApiClient; modes: EndpointModes; resetMock(): void; resetCount: number };

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider({ children }: { children: ReactNode }) {
  const [resetCount, setResetCount] = useState(0);
  const [base] = useState<Omit<ApiContextValue, "resetCount">>(() => {
    const modes = parseRealEndpoints(process.env.NEXT_PUBLIC_REAL_ENDPOINTS);
    for (const w of endpointWarnings(modes)) console.warn(`[CentMe] NEXT_PUBLIC_REAL_ENDPOINTS: ${w}`);
    const mock = createMockClient({
      storage: browserStorage("local"),
      notify: ntfyNotifier(process.env.NEXT_PUBLIC_NTFY_TOPIC),
      delayMs: 900,
    });
    const real = createRealClient({
      onSchemaMismatch: (endpoint, issues) => {
        console.error(`[CentMe] contract mismatch on ${endpoint}`, issues);
        if (process.env.NODE_ENV !== "production") toast.error(`${endpoint}: ${issues[0] ?? "schema mismatch"}`);
      },
    });
    return {
      api: createRoutedClient(modes, real, mock),
      modes,
      resetMock: () => {
        mock.reset();
        setResetCount((n) => n + 1);
      },
    };
  });
  const value = useMemo(() => ({ ...base, resetCount }), [base, resetCount]);

  useEffect(() => {
    base.api.createSession().catch(() => {
      // 401 handling in the real client re-creates the session on the next call
    });
  }, [base]);

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiContextValue {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error("useApi must be used inside <ApiProvider>");
  return ctx;
}
