"use client";

import { Landmark, Loader2 } from "lucide-react";
import { EvidenceTag } from "@/components/common/EvidenceTag";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/web/i18n/LanguageProvider";

type Props = {
  open: boolean;
  onOpenChange(open: boolean): void;
  amountText: string;
  paying: boolean;
  onConfirm(): void;
};

export function BankSheet({ open, onOpenChange, amountText, paying, onConfirm }: Props) {
  const { t } = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={!paying}>
        <DialogHeader>
          <DialogTitle>{t("sheet.title")}</DialogTitle>
          <DialogDescription>{t("sheet.simNote")}</DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border bg-background p-4">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{t("sheet.from")}</span>
            <EvidenceTag tag="SIMULATED" />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Landmark className="size-5 text-brand" aria-hidden />
            <span className="font-medium">{t("sheet.account")}</span>
          </div>
          <p className="tabular mt-4 text-3xl font-semibold">{amountText}</p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={paying}>
            {t("sheet.cancel")}
          </Button>
          <Button className="h-12 text-base font-semibold" onClick={onConfirm} disabled={paying} autoFocus>
            {paying && <Loader2 className="animate-spin" aria-hidden />}
            {t("sheet.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
