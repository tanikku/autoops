"use client";

import type { NotificationType } from "@/components/notification/notification-provider";

export type Toast = {
  id: number;
  type: NotificationType;
  message: string;
};

/** Styled with the existing theme tokens so toasts match the rest of the app. */
const toneClassName: Record<NotificationType, string> = {
  success: "border-border bg-background",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
  info: "border-border bg-muted",
};

export function ToastList({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    // Full width on small screens so long messages never overflow; anchored to
    // the top-right from `sm` up. The container ignores pointer events so it
    // never blocks the page underneath.
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 top-4 z-50 flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-4 sm:w-full sm:max-w-sm"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.type === "error" ? "alert" : "status"}
          className={`pointer-events-auto flex items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg ${toneClassName[toast.type]}`}
        >
          <span className="min-w-0 flex-1 break-words">{toast.message}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(toast.id)}
            className="-mr-1 shrink-0 rounded px-1 leading-none opacity-60 outline-none hover:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
