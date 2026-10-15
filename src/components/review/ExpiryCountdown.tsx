"use client";

import { useEffect, useRef, useState } from "react";
import { formatCountdown } from "@/web/format";
import { useT } from "@/web/i18n/LanguageProvider";

export function ExpiryCountdown({ expiresAt, expired, onExpire }: { expiresAt: string; expired: boolean; onExpire(): void }) {
  const { t } = useT();
  const [remaining, setRemaining] = useState(() => Date.parse(expiresAt) - Date.now());
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  });

  useEffect(() => {
    if (expired) return;
    const tick = () => {
      const ms = Date.parse(expiresAt) - Date.now();
      setRemaining(ms);
      if (ms <= 0) onExpireRef.current();
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt, expired]);

  if (expired) {
    return (
      <span role="status" className="shrink-0 rounded-full bg-destructive/10 px-3 py-1 text-sm font-medium text-destructive">
        {t("review.expired")}
      </span>
    );
  }
  return (
    <span role="timer" className="tabular shrink-0 rounded-full bg-secondary px-3 py-1 text-sm font-medium text-brand">
      {t("review.expiresIn", { time: formatCountdown(remaining) })}
    </span>
  );
}
