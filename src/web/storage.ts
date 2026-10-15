export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const fallback = { local: memoryStore(), session: memoryStore() };

/** Browser storage that never throws; falls back to memory on the server or when storage is blocked. */
export function browserStorage(kind: "local" | "session"): KeyValueStore {
  let target: Storage | null = null;
  try {
    if (typeof window !== "undefined") target = kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    target = null;
  }
  if (!target) return fallback[kind];
  const s = target;
  return {
    getItem: (k) => {
      try { return s.getItem(k); } catch { return fallback[kind].getItem(k); }
    },
    setItem: (k, v) => {
      try { s.setItem(k, v); } catch { fallback[kind].setItem(k, v); }
    },
    removeItem: (k) => {
      try { s.removeItem(k); } catch { fallback[kind].removeItem(k); }
    },
  };
}
