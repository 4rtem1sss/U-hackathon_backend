import type { ReactNode } from "react";
import { cn } from "@/web/utils";

export function SummaryRow({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("tabular min-w-0 text-right", strong ? "text-base font-semibold" : "font-medium")}>{value}</dd>
    </div>
  );
}
