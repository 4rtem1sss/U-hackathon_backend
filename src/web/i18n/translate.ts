import type { Lang } from "../lang";
import { en, type MessageKey } from "./en";
import { th } from "./th";

export type TFn = (key: MessageKey, vars?: Record<string, string>) => string;

const DICTS: Record<Lang, Record<MessageKey, string>> = { en, th };

export function translate(lang: Lang, key: MessageKey, vars?: Record<string, string>): string {
  const template = DICTS[lang][key] ?? en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match);
}
