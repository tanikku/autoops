"use client";

import { CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { NotificationType } from "@/components/notification/notification-provider";

export type Toast = {
  id: number;
  type: NotificationType;
  message: string;
};

/**
 * One visual treatment per outcome.
 *
 * The tinted surface and the accent both carry the meaning, so the type is
 * readable at a glance and still legible to anyone who cannot separate the
 * hues — the icon and the title say the same thing the colour does.
 *
 * Message text stays on `foreground` rather than a tint of the accent: it is
 * the part that has to be read, and the tinted surfaces are light enough that
 * a coloured body would lose contrast.
 */
const tones: Record<
  NotificationType,
  { title: string; surface: string; accent: string; Icon: typeof CircleCheck }
> = {
  success: {
    title: "Success",
    surface:
      "border-emerald-600/30 bg-emerald-50 dark:border-emerald-400/30 dark:bg-emerald-950",
    accent: "text-emerald-700 dark:text-emerald-400",
    Icon: CircleCheck,
  },
  error: {
    title: "Error",
    // `destructive` is the theme's own error token, so errors match the
    // destructive buttons they usually follow.
    surface: "border-destructive/40 bg-destructive/10",
    accent: "text-destructive",
    Icon: TriangleAlert,
  },
  info: {
    title: "Info",
    surface:
      "border-blue-600/30 bg-blue-50 dark:border-blue-400/30 dark:bg-blue-950",
    accent: "text-blue-700 dark:text-blue-400",
    Icon: Info,
  },
};

export function ToastList({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    // `top-20` clears the dashboard header, which is 4rem tall — at `top-4` the
    // toast sat on top of it and the message was unreadable.
    //
    // Full width on small screens so long messages never overflow; anchored to
    // the top-right from `sm` up. The container ignores pointer events so it
    // never blocks the page underneath.
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 top-20 z-50 flex flex-col items-stretch gap-3 sm:inset-x-auto sm:right-6 sm:w-full sm:max-w-sm"
    >
      {toasts.map((toast) => {
        const { title, surface, accent, Icon } = tones[toast.type];

        return (
          <div
            key={toast.id}
            role={toast.type === "error" ? "alert" : "status"}
            className={`pointer-events-auto flex items-start gap-3 rounded-xl border p-4 text-foreground shadow-lg duration-200 animate-in fade-in slide-in-from-top-2 ${surface}`}
          >
            <Icon className={`mt-0.5 size-5 shrink-0 ${accent}`} aria-hidden />

            <div className="min-w-0 flex-1">
              <p className={`text-sm font-semibold ${accent}`}>{title}</p>
              <p className="mt-0.5 text-sm break-words">{toast.message}</p>
            </div>

            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => onDismiss(toast.id)}
              className="-mt-1 -mr-1 shrink-0 rounded-md p-1 text-muted-foreground outline-none hover:bg-black/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 dark:hover:bg-white/10"
            >
              <svg
                viewBox="0 0 16 16"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
