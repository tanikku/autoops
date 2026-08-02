"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { WorkerFieldErrors, WorkerFieldName } from "@/lib/worker-input";
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

/**
 * Nulls are accepted so a rejected submission can be fed straight back in:
 * `readWorkerForm` reports an unrecognised status or frequency as null.
 */
export type WorkerFieldValues = {
  name?: string;
  description?: string;
  prompt?: string;
  frequency?: RoutineFrequency | null;
  status?: RoutineStatus | null;
};

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) {
    return null;
  }

  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}

/**
 * Wires a field to its message: the input is marked invalid and points at the
 * text through `aria-describedby`, so a screen reader reads the reason rather
 * than announcing an unexplained error state.
 */
function errorProps(field: WorkerFieldName, message?: string) {
  return {
    id: field,
    name: field,
    "aria-invalid": message ? true : undefined,
    "aria-describedby": message ? `${field}-error` : undefined,
  };
}

/**
 * Every editable field of a worker, shared by the hire and edit forms.
 *
 * Both forms render this rather than their own copy, so a field cannot exist
 * on one and be missing from the other — which is exactly how Description and
 * Schedule ended up creatable but not editable.
 *
 * Values are uncontrolled defaults: the forms submit through a server action,
 * which reads the FormData rather than component state. Messages are supplied
 * by the caller — this component displays validation, it does not perform it.
 */
export function WorkerFields({
  values,
  errors = {},
}: {
  values: WorkerFieldValues;
  errors?: WorkerFieldErrors;
}) {
  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor="name">Name</Label>
        <Input
          {...errorProps("name", errors.name)}
          required
          defaultValue={values.name}
          placeholder="Daily Website Update"
        />
        <FieldError id="name-error" message={errors.name} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="description">Description</Label>
        <Input
          {...errorProps("description", errors.description)}
          defaultValue={values.description}
          placeholder="What does this worker do?"
        />
        <FieldError id="description-error" message={errors.description} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="prompt">Prompt</Label>
        <Textarea
          {...errorProps("prompt", errors.prompt)}
          rows={5}
          defaultValue={values.prompt}
          placeholder="Instructions sent to the AI on every run."
        />
        <FieldError id="prompt-error" message={errors.prompt} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="frequency">Frequency</Label>
        <select
          id="frequency"
          name="frequency"
          defaultValue={values.frequency ?? "manual"}
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
          defaultValue={values.status ?? "draft"}
          className={selectClassName}
        >
          {routineStatuses.map((status) => (
            <option key={status} value={status}>
              {statusLabels[status]}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
