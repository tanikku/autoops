"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  updateRoutineAction,
  type UpdateRoutineState,
} from "@/app/dashboard/workers/[id]/edit/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  routineFrequencies,
  routineStatuses,
  type RoutineFrequency,
  type RoutineStatus,
} from "@/types";

const statusLabels: Record<RoutineStatus, string> = {
  active: "Active",
  paused: "Paused",
  draft: "Draft",
};

const frequencyLabels: Record<RoutineFrequency, string> = {
  manual: "Manual",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

const selectClassName =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

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
  worker: {
    id: string;
    name: string;
    prompt: string;
    frequency: RoutineFrequency;
    status: RoutineStatus;
  };
}) {
  // The id travels with the action rather than the form, so it cannot be
  // swapped by the client.
  const [state, formAction] = useActionState<UpdateRoutineState, FormData>(
    updateRoutineAction.bind(null, worker.id),
    null,
  );

  return (
    <form action={formAction} className="mt-8 flex max-w-2xl flex-col gap-6">
      <div className="grid gap-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" required defaultValue={worker.name} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="prompt">Prompt</Label>
        <Textarea
          id="prompt"
          name="prompt"
          rows={5}
          defaultValue={worker.prompt}
          placeholder="Instructions sent to the AI on every run."
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="frequency">Frequency</Label>
        <select
          id="frequency"
          name="frequency"
          defaultValue={worker.frequency}
          className={selectClassName}
        >
          {routineFrequencies.map((frequency) => (
            <option key={frequency} value={frequency}>
              {frequencyLabels[frequency]}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="status">Status</Label>
        <select
          id="status"
          name="status"
          defaultValue={worker.status}
          className={selectClassName}
        >
          {routineStatuses.map((status) => (
            <option key={status} value={status}>
              {statusLabels[status]}
            </option>
          ))}
        </select>
      </div>

      {state?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <SaveButton />
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href="/dashboard" />}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
