"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  updateRoutineAction,
  type UpdateRoutineState,
} from "@/app/dashboard/workers/[id]/edit/actions";
import { useActionResult } from "@/components/notification/use-action-result";
import { Button } from "@/components/ui/button";
import {
  useScrollToFirstError,
  WorkerFields,
  type WorkerFieldValues,
} from "@/components/worker-fields";
import { minutesToTimeValue } from "@/lib/worker-input";

function SaveButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

export function WorkerEditForm({
  worker,
}: {
  worker: WorkerFieldValues & { id: string };
}) {
  // The id travels with the action rather than the form, so it cannot be
  // swapped by the client.
  const [state, formAction] = useActionState<UpdateRoutineState, FormData>(
    updateRoutineAction.bind(null, worker.id),
    null,
  );

  // Bumped on every submit so the form remounts with the result. `defaultValue`
  // is read once at initialisation; feeding rejected input back through it on
  // a re-render changes it after the fact, which Base UI rejects.
  const [attempt, setAttempt] = useState(0);

  // Editing is reached from the detail page, so saving returns there.
  const detailHref = `/dashboard/workers/${worker.id}`;
  useActionResult(state, { redirectTo: detailHref });
  useScrollToFirstError(state?.errors);

  return (
    <form
      key={attempt}
      action={(formData) => {
        setAttempt((count) => count + 1);
        formAction(formData);
      }}
      className="mt-8 flex max-w-2xl flex-col gap-6"
    >
      {/* A rejected submission wins over the stored worker, so the fields keep
          what was typed instead of reverting on a validation error. */}
      <WorkerFields
        values={
          state?.values
            ? {
                ...state.values,
                runAt: minutesToTimeValue(state.values.runAtMinutes),
                runAtWeekday: state.values.runAtWeekday,
              }
            : worker
        }
        errors={state?.errors}
      />

      <div className="flex gap-2">
        <SaveButton />
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href={detailHref} />}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
