import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { NotificationFeedItem } from "@/lib/api-types";

const VISIBLE_POLL_MS = 30_000;

export function useNotificationsFeed() {
  const [items, setItems] = useState<NotificationFeedItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const latestRevision = useRef<number | null>(null);
  const requestInFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      const nextItems = await api.getNotifications();
      setItems(nextItems);
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      requestInFlight.current = false;
      setIsLoading(false);
    }
  }, []);

  const refreshFromConversationRevision = useCallback(
    (revision: number) => {
      if (!Number.isSafeInteger(revision) || revision < 0) return;
      if (latestRevision.current !== null && revision <= latestRevision.current) return;
      latestRevision.current = revision;
      void refresh();
    },
    [refresh],
  );

  const markRead = useCallback(async (id: string) => {
    try {
      await api.markNotificationRead(id);
      setItems((current) =>
        current.map((item) =>
          item.id === id && item.readAt === null
            ? { ...item, readAt: new Date().toISOString() }
            : item,
        ),
      );
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, VISIBLE_POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const unreadCount = items.reduce((count, item) => count + (item.readAt === null ? 1 : 0), 0);

  return {
    items,
    unreadCount,
    isEmpty: !isLoading && !error && items.length === 0,
    isLoading,
    error,
    markRead,
    refresh,
    refreshFromConversationRevision,
  };
}
