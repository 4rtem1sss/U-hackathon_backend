"use client";

import { useEffect } from "react";
import { HoldCard } from "@/components/track/TrackView";

/** Backstop: any render error on the track page shows the hold state instead of a blank screen. */
export default function TransferError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error("[CentMe] track page error", error);
  }, [error]);
  return <HoldCard />;
}
