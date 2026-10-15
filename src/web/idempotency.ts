import { browserStorage, type KeyValueStore } from "./storage";

/** crypto.randomUUID needs a secure context; getRandomValues also works over plain http on a LAN. */
export function uuidV4(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** One key per logical action; every retry of that action reuses it. */
export function getOrCreateKey(name: string, store: KeyValueStore = browserStorage("session")): string {
  const storageKey = `centme:key:${name}`;
  const existing = store.getItem(storageKey);
  if (existing) return existing;
  const fresh = uuidV4();
  store.setItem(storageKey, fresh);
  return fresh;
}
