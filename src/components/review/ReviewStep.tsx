"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EvidenceTag } from "@/components/common/EvidenceTag";
import { SummaryRow } from "@/components/common/SummaryRow";
import { Button } from "@/components/ui/button";
import { useApi } from "@/web/api/ApiProvider";
import { isApiError } from "@/web/api/errors";
import type { Quote, Recipient } from "@/web/api/types";
import { readScenario } from "@/web/demoScenario";
import { maskAccount } from "@/web/format";
import { getOrCreateKey } from "@/web/idempotency";
import { errorText } from "@/web/i18n/errorText";
import { useT } from "@/web/i18n/LanguageProvider";
import { formatMinor, formatRate } from "@/web/money";
import { cn } from "@/web/utils";
import { BankSheet } from "./BankSheet";
import { ExpiryCountdown } from "./ExpiryCountdown";

type Props = {
  quote: Quote;
  recipient: Recipient;
  onEdit(): void;
  onNewQuote(): Promise<boolean>;
  quoting: boolean;
};

export function ReviewStep({ quote, recipient, onEdit, onNewQuote, quoting }: Props) {
  const { api } = useApi();
  const { t, lang } = useT();
  const router = useRouter();
  const [expired, setExpired] = useState(() => Date.now() >= Date.parse(quote.expiresAt));
  const [sheetOpen, setSheetOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const payingRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // A new quote remounts this component (key={quote.id} in src/app/page.tsx), so `expired` starts fresh.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  async function confirm() {
    if (payingRef.current) return;
    payingRef.current = true;
    setPaying(true);
    try {
      const key = getOrCreateKey(`transfer:${quote.id}`);
      const transfer = await api.createTransfer(
        { quoteId: quote.id, purpose: "PERSONAL_REMITTANCE", demoScenario: readScenario() },
        key,
      );
      router.replace(`/transfers/${encodeURIComponent(transfer.id)}?fund=1`);
    } catch (e) {
      payingRef.current = false;
      setPaying(false);
      if (isApiError(e, "QUOTE_EXPIRED")) {
        setSheetOpen(false);
        setExpired(true);
      } else if (isApiError(e, "QUOTE_ALREADY_ACCEPTED")) {
        setSheetOpen(false);
        toast.error(t("review.alreadyUsed"));
        onEdit();
      } else {
        toast.error(errorText(e, t));
      }
    }
  }

  const amountText = formatMinor(quote.sourceDebitMinor, "USD", lang);

  return (
    <section aria-labelledby="review-title" className="mx-auto max-w-xl rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
      <div className="flex items-start justify-between gap-4">
        <h1 id="review-title" ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
          {t("review.title")}
        </h1>
        <ExpiryCountdown expiresAt={quote.expiresAt} expired={expired} onExpire={() => setExpired(true)} />
      </div>

      <div className={cn("mt-6 transition-opacity", expired && "opacity-50")}>
        <p className="text-sm text-muted-foreground">{t("send.theyReceive")}</p>
        <p className="tabular mt-1 text-4xl font-semibold tracking-tight text-brand">
          {formatMinor(quote.destinationNetMinor, "THB", lang)}
        </p>
        <dl className="mt-6 space-y-3 border-t pt-6 text-base">
          <SummaryRow label={t("review.youSend")} value={amountText} strong />
          <SummaryRow label={t("send.fee")} value={formatMinor(quote.feeMinor, "USD", lang)} />
          <SummaryRow label={t("send.rate")} value={formatRate(quote.fxRateNumerator, quote.fxRateDenominator, lang)} />
          <SummaryRow
            label={t("send.recipientLabel")}
            value={`${recipient.name} · ${recipient.bankLabel} ${maskAccount(recipient.accountDisplay)}`}
          />
          {quote.checks && (
            <SummaryRow
              label={t("review.checks")}
              value={
                <span className="inline-flex items-center gap-2">
                  {t("review.checksPassed")}
                  <EvidenceTag tag="SIMULATED" />
                </span>
              }
            />
          )}
          <SummaryRow label={t("send.arrival")} value={t("send.timing")} />
        </dl>
      </div>

      <div className="mt-8 flex flex-col gap-3">
        {expired ? (
          <Button className="h-12 text-base font-semibold" onClick={() => void onNewQuote()} disabled={quoting}>
            {quoting && <Loader2 className="animate-spin" aria-hidden />}
            {t("review.newQuote")}
          </Button>
        ) : (
          <Button className="h-12 text-base font-semibold" onClick={() => setSheetOpen(true)}>
            {t("review.pay", { amount: amountText })}
          </Button>
        )}
        <Button variant="ghost" onClick={onEdit} disabled={paying}>
          {t("review.edit")}
        </Button>
      </div>

      <BankSheet
        open={sheetOpen}
        onOpenChange={(open) => {
          if (!payingRef.current) setSheetOpen(open);
        }}
        amountText={amountText}
        paying={paying}
        onConfirm={() => void confirm()}
      />
    </section>
  );
}
