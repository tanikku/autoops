"use client";

import { useRef, useTransition } from "react";
import { deleteWorkerAction } from "@/app/dashboard/actions";
import { useNotify } from "@/components/notification/notification-provider";
import { Button } from "@/components/ui/button";

export function DeleteWorkerButton({
  workerId,
  workerName,
}: {
  workerId: string;
  workerName: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const notify = useNotify();
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    dialog.current?.close();

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
        {pending ? "Deleting…" : "Delete"}
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
          Delete “{workerName}”?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This also removes its activity history. This cannot be undone.
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </Button>
          {/* The id is passed by the handler, not the form, so it cannot be
              swapped client-side. */}
          <Button type="button" variant="destructive" onClick={handleDelete}>
            Delete
          </Button>
        </div>
      </dialog>
    </>
  );
}
