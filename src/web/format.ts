import { LOCALE, type Lang } from "./lang";

export function maskAccount(display: string): string {
  return `••${display.replace(/\s+/g, "").slice(-4)}`;
}

export function shortHash(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("");
}

export function formatDateTime(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: "medium", timeStyle: "medium" }).format(new Date(iso));
}
