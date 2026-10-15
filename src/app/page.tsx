"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AmountField } from "@/components/send/AmountField";
import { EstimateCard } from "@/components/send/EstimateCard";
import { ChecksAlert, type ChecksBlock } from "@/components/send/ChecksAlert";
import { RecipientCard } from "@/components/send/RecipientCard";
import { ReviewStep } from "@/components/review/ReviewStep";
import { Button } from "@/components/ui/button";
import { useApi } from "@/web/api/ApiProvider";
import { isApiError } from "@/web/api/errors";
import type { Quote, Recipient } from "@/web/api/types";
import { readCheckScenario } from "@/web/demoScenario";
import { errorText } from "@/web/i18n/errorText";
import { useT } from "@/web/i18n/LanguageProvider";
import { estimateQuote, parseUsdInput, type ParseError } from "@/web/money";
import { pickRecipient, RECIPIENT_KEY } from "@/web/recipientChoice";
import { browserStorage } from "@/web/storage";

const AMOUNT_KEY = "centme:amount";

export default function SendPage() {
  const { api, resetCount } = useApi();
  const { t } = useT();
  const [step, setStep] = useState<1 | 2>(1);
  const [amount, setAmount] = useState("10.00");
  const [amountError, setAmountError] = useState<ParseError | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [recipientFailed, setRecipientFailed] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [checksBlock, setChecksBlock] = useState<ChecksBlock | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = browserStorage("session").getItem(AMOUNT_KEY);
    // Restore once after hydration (server render has no sessionStorage).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setAmount(saved);
  }, []);

  useEffect(() => {
    api.getRecipients()
      .then((list) => setRecipient(pickRecipient(list, browserStorage("session").getItem(RECIPIENT_KEY))))
      .catch(() => setRecipientFailed(true));
    // resetCount: a presenter Reset drops mock recipients, so the selection must be re-picked.
  }, [api, resetCount]);

  const parsed = parseUsdInput(amount);
  const estimate = parsed.ok ? estimateQuote(parsed.minor) : null;
  const fieldError = amountError ? t(`send.error.${amountError}` as const) : serverError;

  function onAmountChange(value: string) {
    setAmount(value);
    setAmountError(null);
    setServerError(null);
    setChecksBlock(null);
    browserStorage("session").setItem(AMOUNT_KEY, value);
  }

  function onRecipientChange(r: Recipient) {
    setRecipient(r);
    setQuote(null);
    setChecksBlock(null);
    setServerError(null);
    browserStorage("session").setItem(RECIPIENT_KEY, r.id);
  }

  function onAmountBlur() {
    if (amount.trim() !== "" && !parsed.ok) setAmountError(parsed.error);
  }

  async function requestQuote(): Promise<boolean> {
    const p = parseUsdInput(amount);
    if (!p.ok) {
      setAmountError(p.error);
      inputRef.current?.focus();
      return false;
    }
    if (!recipient) return false;
    setQuoting(true);
    setChecksBlock(null);
    try {
      const check = readCheckScenario();
      setQuote(
        await api.createQuote({
          recipientId: recipient.id,
          sourceDebitMinor: p.minor,
          ...(check === "PASS" ? {} : { demoCheckScenario: check }),
        }),
      );
      return true;
    } catch (e) {
      if (isApiError(e, "CHECKS_REJECTED") || isApiError(e, "CHECKS_REVIEW_REQUIRED")) {
        // No quote exists. Drop any old one and show the alert on step 1 (also when called from "Get new quote").
        setQuote(null);
        setChecksBlock(e.code as ChecksBlock);
        setStep(1);
      } else if (isApiError(e, "INVALID_INPUT")) {
        setServerError(e.fieldErrors.sourceDebitMinor ?? e.message);
        inputRef.current?.focus();
      } else {
        toast.error(errorText(e, t));
      }
      return false;
    } finally {
      setQuoting(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (await requestQuote()) setStep(2);
  }

  if (step === 2 && quote && recipient) {
    return (
      <ReviewStep
        key={quote.id}
        quote={quote}
        recipient={recipient}
        onEdit={() => setStep(1)}
        onNewQuote={requestQuote}
        quoting={quoting}
      />
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px] lg:items-start">
      <form onSubmit={onSubmit} aria-labelledby="send-title" className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8" noValidate>
        <h1 id="send-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">{t("send.title")}</h1>
        <div className="mt-8 space-y-6">
          <AmountField value={amount} onChange={onAmountChange} onBlur={onAmountBlur} errorText={fieldError} inputRef={inputRef} />
          <RecipientCard recipient={recipient} failed={recipientFailed} onChange={onRecipientChange} />
        </div>
        {checksBlock && <ChecksAlert code={checksBlock} />}
        <Button type="submit" className="mt-8 h-12 w-full text-base font-semibold" disabled={quoting || !recipient}>
          {quoting && <Loader2 className="animate-spin" aria-hidden />}
          {t("send.continue")}
        </Button>
      </form>
      <EstimateCard estimate={estimate} />
    </div>
  );
}
