"use client";

import { AlertTriangle, Loader2, WifiOff } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useApi } from "@/web/api/ApiProvider";
import { isApiError, NetworkError } from "@/web/api/errors";
import { getOrCreateKey } from "@/web/idempotency";
import { errorText } from "@/web/i18n/errorText";
import { useT } from "@/web/i18n/LanguageProvider";
import { formatMinor } from "@/web/money";
import { toView, type PrimaryAction } from "@/web/status";
import { useTransfer } from "@/web/useTransfer";
import { Details } from "./Details";
import { NotifiedChip } from "./NotifiedChip";
import { Receipt } from "./Receipt";
import { Timeline } from "./Timeline";

export function TrackView({ id }: { id: string }) {
  const { api } = useApi();
  const { t, lang } = useT();
  const router = useRouter();
  const { snapshot, error, accept, kick } = useTransfer(id);
  const [busy, setBusy] = useState(false);
  const autoFundRef = useRef(false);

  const runFunding = useCallback(async () => {
    setBusy(true);
    try {
      accept(await api.simulateFunding(id, getOrCreateKey(`funding:${id}`)));
      kick();
    } catch (e) {
      if (isApiError(e, "INVALID_STATE")) kick();
      else toast.error(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }, [api, id, accept, kick, t]);

  // Arriving from the bank sheet: fund once. Refresh replays the same key, so no double funding.
  useEffect(() => {
    if (autoFundRef.current || !snapshot) return;
    if (new URLSearchParams(window.location.search).get("fund") !== "1") return;
    autoFundRef.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    // One-time network action on arrival; runFunding sets busy state for the button.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (snapshot.status === "FUNDING_PENDING") void runFunding();
  }, [snapshot, runFunding]);

  async function retryPayout() {
    if (!snapshot) return;
    setBusy(true);
    try {
      accept(await api.retryPayout(id, getOrCreateKey(`payout:${id}:${snapshot.version}`)));
      kick();
    } catch (e) {
      if (isApiError(e, "INVALID_STATE")) kick();
      else toast.error(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  function onAction(action: NonNullable<PrimaryAction>) {
    if (action === "FINISH_PAYMENT") void runFunding();
    else if (action === "RETRY_PAYOUT") void retryPayout();
    else router.push("/");
  }

  if (!snapshot) {
    if (isApiError(error, "NOT_FOUND")) {
      return (
        <section className="mx-auto max-w-xl rounded-2xl border bg-card p-8 text-center shadow-sm">
          <h1 className="text-2xl font-semibold">{t("track.notFound")}</h1>
          <Button asChild className="mt-6 h-12 text-base font-semibold">
            <Link href="/">{t("action.START_OVER")}</Link>
          </Button>
        </section>
      );
    }
    return (
      <section role="status" aria-label={t("common.loading")} className="mx-auto max-w-3xl rounded-2xl border bg-card p-8 shadow-sm">
        <div className="h-4 w-48 animate-pulse rounded bg-muted" />
        <div className="mt-3 h-8 w-72 animate-pulse rounded bg-muted" />
        <div className="mt-8 space-y-6">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded bg-muted" />)}
        </div>
      </section>
    );
  }

  const view = toView(snapshot);
  const a = snapshot.amounts;

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <section aria-labelledby="track-title" className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
        <p className="tabular text-sm text-muted-foreground">
          {t("track.summary", {
            send: formatMinor(a.sourceDebitMinor, "USD", lang),
            receive: formatMinor(a.destinationNetMinor, "THB", lang),
            name: snapshot.recipient.name,
          })}
        </p>
        <h1 id="track-title" aria-live="polite" className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          {t(view.headlineKey)}
        </h1>

        {error instanceof NetworkError && (
          <p role="status" className="mt-4 flex items-center gap-2 rounded-xl bg-muted p-3 text-sm text-muted-foreground">
            <WifiOff className="size-4 shrink-0" aria-hidden />
            {t("track.offline")}
          </p>
        )}
        {view.issueMessage && (
          <p role="status" className="mt-4 flex items-start gap-2 rounded-xl bg-pending/10 p-3 text-sm text-pending">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {view.issueMessage}
          </p>
        )}

        <Timeline className="mt-8" view={view} snapshot={snapshot} />

        {view.notified && <div className="mt-6"><NotifiedChip /></div>}

        {view.action && !view.showReceipt && (
          <Button className="mt-6 h-12 w-full text-base font-semibold sm:w-auto" onClick={() => onAction(view.action!)} disabled={busy}>
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            {t(`action.${view.action}` as const)}
          </Button>
        )}

        <Details snapshot={snapshot} className="mt-6" />
      </section>

      {view.showReceipt && <Receipt snapshot={snapshot} onSendAnother={() => router.push("/")} />}
    </div>
  );
}
