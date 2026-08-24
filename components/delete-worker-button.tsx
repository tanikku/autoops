"use client";

import { useRouter } from "next/navigation";
import { useRef, useTransition } from "react";
import { deleteWorkerAction } from "@/app/dashboard/actions";
import { useNotify } from "@/components/notification/notification-provider";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export function DeleteWorkerButton({
  workerId,
  workerName,
  redirectTo,
  language,
}: {
  workerId: string;
  workerName: string;
  /** Where to go before deleting, for callers whose page shows this worker. */
  redirectTo?: string;
  /**
   * The language the dialog is written in. The worker's name inside the
   * question is the owner's and is placed into the sentence rather than glued
   * to one end of it — the two languages do not put it in the same spot.
   */
  language: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const notify = useNotify();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    dialog.current?.close();

    // Navigating first, not after: a server action re-renders the page it was
    // called from, and a page built around this worker cannot survive that.
    if (redirectTo) {
      router.push(redirectTo);
    }

    startTransition(async () => {
      // A successful delete removes the card, and this button with it, so the
      // toast is raised straight from the closure. An effect would never run:
      // the component is gone by the time the result lands.
      const result = await deleteWorkerAction(workerId, null);

      if (result) {
        notify({ type: result.status, message: result.message });
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => dialog.current?.showModal()}
      >
        {t(language, pending ? "worker.delete.deleting" : "worker.delete.button")}
      </Button>

      <dialog
        ref={dialog}
        aria-labelledby={`delete-worker-title-${workerId}`}
        className="max-w-sm rounded-xl border border-border bg-background p-6 text-foreground shadow-lg backdrop:bg-black/50"
      >
        <h2
          id={`delete-worker-title-${workerId}`}
          className="text-base font-medium"
        >
          {t(language, "worker.delete.confirmTitle", { name: workerName })}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(language, "worker.delete.confirmBody")}
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => dialog.current?.close()}
          >
            {t(language, "common.cancel")}
          </Button>
          {/* The id is passed by the handler, not the form, so it cannot be
              swapped client-side. */}
          <Button type="button" variant="destructive" onClick={handleDelete}>
            {t(language, "worker.delete.button")}
          </Button>
        </div>
      </dialog>
    </>
  );
}
