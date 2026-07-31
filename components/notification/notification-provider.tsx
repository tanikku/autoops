"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ToastList, type Toast } from "@/components/notification/toast-list";

export type NotificationType = "success" | "error" | "info";

type Notify = (notification: {
  type: NotificationType;
  message: string;
}) => void;

const NotificationContext = createContext<Notify | null>(null);

const DISMISS_AFTER_MS = 5000;

/**
 * Notifications live in the root layout so they survive client-side
 * navigation: an action can report success and send the user elsewhere in the
 * same tick without the toast disappearing with the page that raised it.
 *
 * Nothing is persisted — a reload clears them, which is why success is no
 * longer signalled through the URL.
 */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback<Notify>(
    ({ type, message }) => {
      const id = nextId.current;
      nextId.current += 1;

      setToasts((current) => [...current, { id, type, message }]);
      setTimeout(() => dismiss(id), DISMISS_AFTER_MS);
    },
    [dismiss],
  );

  return (
    <NotificationContext.Provider value={notify}>
      {children}
      <ToastList toasts={toasts} onDismiss={dismiss} />
    </NotificationContext.Provider>
  );
}

export function useNotify(): Notify {
  const notify = useContext(NotificationContext);

  if (!notify) {
    throw new Error("useNotify must be used inside <NotificationProvider>");
  }

  return notify;
}
