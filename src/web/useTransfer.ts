"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "./api/ApiProvider";
import { isApiError } from "./api/errors";
import type { TransferSnapshot } from "./api/types";
import { startTransferPoller, type TransferPoller } from "./transferPoller";

export function useTransfer(id: string) {
  const { api } = useApi();
  const [snapshot, setSnapshot] = useState<TransferSnapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const pollerRef = useRef<TransferPoller | null>(null);

  useEffect(() => {
    const poller = startTransferPoller(id, {
      api,
      onSnapshot: (s) => {
        setSnapshot(s);
        setError(null);
      },
      onError: (e) => {
        setError(e);
        if (isApiError(e, "NOT_FOUND")) pollerRef.current?.stop();
      },
    });
    pollerRef.current = poller;
    return () => poller.stop();
  }, [api, id]);

  const accept = useCallback((s: TransferSnapshot) => pollerRef.current?.accept(s), []);
  const kick = useCallback(() => pollerRef.current?.kick(), []);

  return { snapshot, error, accept, kick };
}
