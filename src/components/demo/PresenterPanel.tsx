"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/web/api/ApiProvider";
import { ENDPOINT_GROUPS } from "@/web/api/index";
import { CHECK_SCENARIOS, DEMO_SCENARIOS, type CheckScenario, type DemoScenario } from "@/web/api/types";
import { readCheckScenario, readScenario, writeCheckScenario, writeScenario } from "@/web/demoScenario";
import { useT } from "@/web/i18n/LanguageProvider";
import { cn } from "@/web/utils";

export function PresenterPanel() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // ?demo=1 opens the panel once after hydration (the server never renders it).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (new URLSearchParams(window.location.search).get("demo") === "1") setOpen(true);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "d" || e.key === "D") setOpen((o) => !o);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;
  return <PanelBody onClose={() => setOpen(false)} />;
}

/** Mounted only while open, so it can read sessionStorage in its initial state. */
function PanelBody({ onClose }: { onClose(): void }) {
  const { modes, resetMock } = useApi();
  const { t } = useT();
  const router = useRouter();
  const [scenario, setScenario] = useState<DemoScenario>(() => readScenario());
  const [checkScenario, setCheckScenario] = useState<CheckScenario>(() => readCheckScenario());

  return (
    <aside aria-label={t("demo.title")} className="fixed bottom-4 right-4 z-50 w-72 rounded-2xl border bg-card p-4 shadow-lg">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("demo.title")}</h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("demo.close")}>
          <X aria-hidden />
        </Button>
      </div>

      <fieldset className="mt-3">
        <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("demo.scenario")}</legend>
        <div className="mt-2 space-y-1">
          {DEMO_SCENARIOS.map((s) => (
            <label key={s} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
              <input
                type="radio"
                name="scenario"
                value={s}
                checked={scenario === s}
                onChange={() => {
                  setScenario(s);
                  writeScenario(s);
                }}
                className="accent-[var(--brand)]"
              />
              {t(`demo.${s}` as const)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-3">
        <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("demo.checks")}</legend>
        <div className="mt-2 flex gap-1">
          {CHECK_SCENARIOS.map((s) => (
            <label key={s} className="flex flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
              <input
                type="radio"
                name="checkScenario"
                value={s}
                checked={checkScenario === s}
                onChange={() => {
                  setCheckScenario(s);
                  writeCheckScenario(s);
                }}
                className="accent-[var(--brand)]"
              />
              {t(`demo.check.${s}` as const)}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("demo.endpoints")}</p>
        <ul className="mt-2 space-y-1 text-sm">
          {ENDPOINT_GROUPS.map((g) => (
            <li key={g} className="flex items-center justify-between">
              <span>{g}</span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-semibold uppercase",
                  modes[g] === "real" ? "bg-primary/40 text-foreground" : "border border-dashed border-pending text-pending",
                )}
              >
                {modes[g]}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <Button
        variant="outline"
        size="sm"
        className="mt-4 w-full"
        onClick={() => {
          resetMock();
          router.push("/");
        }}
      >
        {t("demo.reset")}
      </Button>
    </aside>
  );
}
