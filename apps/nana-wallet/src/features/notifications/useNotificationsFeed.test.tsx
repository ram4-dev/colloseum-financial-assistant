import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { api } from "@/lib/api";
import type { NotificationFeedItem } from "@/lib/api-types";

import { useNotificationsFeed } from "./useNotificationsFeed";

// RED contract shape: the typed feed API (task 3.1) will add this to api-types.
// Declared locally so the RED test compiles against the not-yet-existing module.
// The feed API members are mocked at the module boundary so these tests prove
// polling and refresh behavior independently from HTTP parsing.
const apiMock = api as unknown as {
  getNotifications: Mock<() => Promise<NotificationFeedItem[]>>;
  markNotificationRead: Mock<(id: string) => Promise<void>>;
};

function feedItem(overrides: Partial<NotificationFeedItem> = {}): NotificationFeedItem {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    category: "assistant_transfer",
    status: "confirmed",
    title: "Transferencia confirmada",
    explanation: "Se enviaron 10 USDT",
    resolved: true,
    projection: {},
    readAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    eventAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("useNotificationsFeed", () => {
  afterEach(() => vi.restoreAllMocks());

  it("loads the feed and reports unread count", async () => {
    const getFeed = vi.spyOn(apiMock, "getNotifications").mockResolvedValue([
      feedItem(),
      feedItem({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        readAt: "2026-01-01T01:00:00.000Z",
      }),
    ]);
    const { result } = renderHook(() => useNotificationsFeed());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.unreadCount).toBe(1);
    expect(getFeed).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state when the feed is empty", async () => {
    vi.spyOn(apiMock, "getNotifications").mockResolvedValue([]);
    const { result } = renderHook(() => useNotificationsFeed());
    await waitFor(() => expect(result.current.isEmpty).toBe(true));
    expect(result.current.items).toEqual([]);
    expect(result.current.unreadCount).toBe(0);
  });

  it("marks a notification read and reflects it in the feed", async () => {
    const item = feedItem();
    vi.spyOn(apiMock, "getNotifications").mockResolvedValue([item]);
    const markRead = vi.spyOn(apiMock, "markNotificationRead").mockResolvedValue(undefined);
    const { result } = renderHook(() => useNotificationsFeed());
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    await act(async () => {
      await result.current.markRead(item.id);
    });
    expect(markRead).toHaveBeenCalledWith(item.id);
    await waitFor(() => expect(result.current.unreadCount).toBe(0));
  });

  it("keeps the item unread and reports a failed mark-read request", async () => {
    const item = feedItem();
    vi.spyOn(apiMock, "getNotifications").mockResolvedValue([item]);
    vi.spyOn(apiMock, "markNotificationRead").mockRejectedValue(new Error("Network error"));
    const { result } = renderHook(() => useNotificationsFeed());
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    await act(async () => {
      await result.current.markRead(item.id);
    });

    expect(result.current.unreadCount).toBe(1);
    expect(result.current.error).toEqual(new Error("Network error"));
  });

  it("polls every 30 seconds while the page is visible and refreshes on focus", async () => {
    vi.useFakeTimers();
    try {
      const getFeed = vi.spyOn(apiMock, "getNotifications").mockResolvedValue([]);
      renderHook(() => useNotificationsFeed());
      await vi.advanceTimersByTimeAsync(0);
      expect(getFeed).toHaveBeenCalledTimes(1);

      // Visible-page polling: exactly one more fetch after 30 seconds, none before.
      await vi.advanceTimersByTimeAsync(29_999);
      expect(getFeed).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(getFeed).toHaveBeenCalledTimes(2);

      // Page focus triggers an immediate refresh.
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(getFeed).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll while the page is hidden", async () => {
    vi.useFakeTimers();
    try {
      const getFeed = vi.spyOn(apiMock, "getNotifications").mockResolvedValue([]);
      renderHook(() => useNotificationsFeed());
      await vi.advanceTimersByTimeAsync(0);
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getFeed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the feed when a LiveKit conversation revision event arrives", async () => {
    const getFeed = vi.spyOn(apiMock, "getNotifications").mockResolvedValue([]);
    const { result } = renderHook(() => useNotificationsFeed());
    await waitFor(() => expect(getFeed).toHaveBeenCalledTimes(1));

    // LiveKit conversation_state_changed carries a revision; the feed hook
    // exposes a revision refresh entry point that the voice session wires to
    // that event (same pattern as useConversationState.refreshRevision).
    await act(async () => {
      result.current.refreshFromConversationRevision(42);
    });
    await waitFor(() => expect(getFeed).toHaveBeenCalledTimes(2));

    // Stale or repeated revisions must not trigger another fetch.
    await act(async () => {
      result.current.refreshFromConversationRevision(42);
      result.current.refreshFromConversationRevision(41);
    });
    await waitFor(() => expect(getFeed).toHaveBeenCalledTimes(2));
    expect(getFeed).toHaveBeenCalledTimes(2);
  });
});
