"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Lang } from "../lang";
import { translate, type TFn } from "./translate";

type LanguageContextValue = { lang: Lang; setLang: (lang: Lang) => void; t: TFn };

const LanguageContext = createContext<LanguageContextValue | null>(null);
const STORAGE_KEY = "centme:lang";

// Language lives in localStorage; useSyncExternalStore reads it after hydration
// (server snapshot is English) without a setState-in-effect round trip.
const listeners = new Set<() => void>();
let memoryLang: Lang | null = null; // used when storage is blocked

function readLang(): Lang {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "th") return saved;
  } catch {
    // storage blocked: fall back to this visit's choice
  }
  return memoryLang ?? "en";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const lang = useSyncExternalStore(subscribe, readLang, () => "en" as const);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    memoryLang = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage blocked: language still switches for this visit
    }
    listeners.forEach((l) => l());
  }, []);

  const t = useCallback<TFn>((key, vars) => translate(lang, key, vars), [lang]);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useT(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useT must be used inside <LanguageProvider>");
  return ctx;
}
