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
import type { RoutineKind } from "@/types";

const kindLabels: Record<RoutineKind, string> = {
  prompt: "Prompt",
  website: "Website",
};

/**
 * What moving a watcher costs, said before it is moved.
 *
 * A baseline only means anything against the page it was taken from, so
 * changing the address throws it away — otherwise the next check would compare
 * two unrelated documents and report the whole of one as a change. That is the
 * right behaviour and it is invisible, which is the only reason this sentence
 * exists.
 *
 * **Every clause is held to what execution actually does**, because a sentence
 * about a mechanism nobody can see is believed:
 *
 * - *the next successful check*, not the next one. A check that cannot fetch
 *   the page writes no baseline and leaves the worker where it was, so
 *   promising one on the next check would promise something a failure breaks.
 * - *instead of treating the new page as a detected change*, rather than
 *   "reports no changes". Establishing a first baseline is its own outcome —
 *   there was nothing to differ from — and it is the outcome worth naming,
 *   because the alternative it rules out is the whole of a new page arriving
 *   as though it had just changed.
 * - *past runs are kept*, because what is thrown away is the stored comparison
 *   point and nothing else. Nothing is fetched when the form is saved, and no
 *   model is involved in establishing a baseline.
 *
 * No confirmation dialog goes with it. A baseline is an internal comparison
 * point rather than anything the person wrote, and a check rebuilds it.
 */
export const BASELINE_RESET_NOTE =
  "Changing the address resets the comparison baseline. On the next " +
  "successful check, AutoOps establishes a new baseline instead of treating " +
  "the new page as a detected change. Past runs are kept.";

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
  timezone,
}: {
  worker: WorkerFieldValues & { id: string; kind: RoutineKind };
  timezone: string;
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
      {/* **Shown, never offered.** What a worker does was decided when it was
          hired and the rest of it is built on that answer: a prompt worker has
          no page to watch, and a website worker turned into one would leave its
          source and baseline pointing at nothing. A selector here would imply a
          conversion that neither the action nor the update type allows, so this
          says which kind it is and stops. */}
      <div className="grid gap-1">
        <span className="text-sm font-medium">Worker type</span>
        <p className="text-sm text-muted-foreground">
          {kindLabels[worker.kind]}
        </p>
      </div>

      {/* A rejected submission wins over the stored worker, so the fields keep
          what was typed instead of reverting on a validation error. The kind is
          not among the values it can change: it comes from the stored worker
          either way, so a rejected save cannot land back on the other form. */}
      <WorkerFields
        values={
          state?.values
            ? {
                ...state.values,
                runAt: minutesToTimeValue(state.values.runAtMinutes),
                runAtWeekday: state.values.runAtWeekday,
                runAtDay: state.values.runAtDay,
              }
            : worker
        }
        errors={state?.errors}
        kind={worker.kind}
        timezone={timezone}
        websiteUrlNote={BASELINE_RESET_NOTE}
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
