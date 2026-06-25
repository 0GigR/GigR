import { create } from 'zustand'

interface UnreadState {
  messageUnread: number
  setMessageUnread: (n: number) => void
  /** Incremented by the global notifier when a new inbound message arrives off the Messages page. */
  bumpUnread: () => void
  /** True while the Messages page is mounted — it owns unread tracking there, so the
   *  global notifier defers to avoid double-counting / duplicate toasts. */
  messagesPageActive: boolean
  setMessagesPageActive: (b: boolean) => void
}

export const useUnreadStore = create<UnreadState>((set) => ({
  messageUnread: 0,
  setMessageUnread: (n) => set({ messageUnread: n }),
  bumpUnread: () => set((s) => ({ messageUnread: s.messageUnread + 1 })),
  messagesPageActive: false,
  setMessagesPageActive: (b) => set({ messagesPageActive: b }),
}))
