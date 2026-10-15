import { computeAmounts, FIXTURE_US_TH_V1, parseSourceDebitMinor } from "@/domain/pricing";
import { LOCALE, type Lang } from "./lang";

/** Same fixture-us-th-v1 the server prices with. Estimates only; the server quote is authoritative. */
export const FIXTURE = {
  version: FIXTURE_US_TH_V1.version,
  rateNumerator: FIXTURE_US_TH_V1.fxRateNumerator,
  rateDenominator: FIXTURE_US_TH_V1.fxRateDenominator,
  minDebitMinor: FIXTURE_US_TH_V1.minDebitMinor,
  maxDebitMinor: FIXTURE_US_TH_V1.maxDebitMinor,
} as const;

export type ParseError = "EMPTY" | "FORMAT" | "TOO_SMALL" | "TOO_LARGE";
export type ParseResult = { ok: true; minor: string } | { ok: false; error: ParseError };

export function parseUsdInput(raw: string): ParseResult {
  const s = raw.trim();
  if (s === "") return { ok: false, error: "EMPTY" };
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return { ok: false, error: "FORMAT" };
  const minor = BigInt(m[1] ?? "0") * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
  if (minor < FIXTURE.minDebitMinor) return { ok: false, error: "TOO_SMALL" };
  if (minor > FIXTURE.maxDebitMinor) return { ok: false, error: "TOO_LARGE" };
  return { ok: true, minor: minor.toString() };
}

export type Estimate = {
  sourceDebitMinor: string;
  feeMinor: string;
  conversionPrincipalMinor: string;
  destinationNetMinor: string;
  settlementTokenUnits: string;
};

export function estimateQuote(debitMinor: string): Estimate {
  const parsed = parseSourceDebitMinor(debitMinor, FIXTURE_US_TH_V1);
  if (!parsed.ok) throw new RangeError(`estimateQuote: ${parsed.error}`);
  const a = computeAmounts(parsed.value, FIXTURE_US_TH_V1);
  return {
    sourceDebitMinor: a.sourceDebitMinor.toString(),
    feeMinor: a.feeMinor.toString(),
    conversionPrincipalMinor: a.conversionPrincipalMinor.toString(),
    destinationNetMinor: a.destinationNetMinor.toString(),
    settlementTokenUnits: a.settlementTokenUnits.toString(),
  };
}

const SYMBOL = { USD: "$", THB: "฿" } as const;

export function formatMinor(minor: string, currency: "USD" | "THB", lang: Lang = "en"): string {
  const v = BigInt(minor);
  const abs = v < 0n ? -v : v;
  const whole = new Intl.NumberFormat(LOCALE[lang]).format(abs / 100n);
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${v < 0n ? "-" : ""}${SYMBOL[currency]}${whole}.${frac}`;
}

export function formatRate(num: string, den: string, lang: Lang = "en"): string {
  const scaled = (BigInt(num) * 10000n) / BigInt(den);
  const whole = new Intl.NumberFormat(LOCALE[lang]).format(scaled / 10000n);
  const frac = (scaled % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return `1 USD = ${whole}${frac ? "." + frac : ""} THB`;
}

export function formatTokenUnits(units: string, decimals = 6, symbol = "USDC"): string {
  const v = BigInt(units);
  const base = 10n ** BigInt(decimals);
  let frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${v / base}.${frac} ${symbol}`;
}

export function minorToInput(minor: string): string {
  const v = BigInt(minor);
  return `${v / 100n}.${(v % 100n).toString().padStart(2, "0")}`;
}

/** Animation helper: integer-only value at a progress in [0, 1]. */
export function interpolateMinor(target: string, progress: number): string {
  const p = Math.min(1, Math.max(0, progress));
  return ((BigInt(target) * BigInt(Math.round(p * 1000))) / 1000n).toString();
}
