"use client";

import { useRef } from "react";
import { useFormStatus } from "react-dom";
import { deleteWorkerAction } from "@/app/dashboard/workers/[id]/edit/actions";
import { Button } from "@/components/ui/button";

function ConfirmDeleteButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant="destructive" disabled={pending}>
      {pending ? "Deleting…" : "Delete"}
    </Button>
  );
}

export function DeleteWorkerButton({ workerId }: { workerId: string }) {
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        onClick={() => dialog.current?.showModal()}
      >
        Delete Worker
      </Button>

      <dialog
        ref={dialog}
        aria-labelledby="delete-worker-title"
        className="max-w-sm rounded-xl border border-border bg-background p-6 text-foreground shadow-lg backdrop:bg-black/50"
      >
        <h2 id="delete-worker-title" className="text-base font-medium">
          Delete this worker?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This action cannot be undone.
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </Button>
          {/* The id travels with the action, so it cannot be swapped client-side. */}
          <form action={deleteWorkerAction.bind(null, workerId)}>
            <ConfirmDeleteButton />
          </form>
        </div>
      </dialog>
    </>
  );
}
