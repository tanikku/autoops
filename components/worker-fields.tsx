"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  workerFieldLimits,
  type WorkerFieldErrors,
  type WorkerFieldName,
} from "@/lib/worker-input";
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

/**
 * A text field with its label, character count and error message.
 *
 * The value stays uncontrolled — the form submits through a server action that
 * reads FormData, not component state — so only the *length* is tracked here.
 * Typing updates a number, never the input's value, which keeps IME composition
 * untouched: nothing rewrites the field mid-conversion.
 *
 * The limit comes from `workerFieldLimits`, the same constant
 * `validateWorkerForm` checks against. The counter cannot promise a bound the
 * server does not enforce.
 *
 * There is no `maxLength`: truncating during IME composition drops characters
 * the user has not finished typing. Going over is allowed, shown, and rejected
 * on submit.
 */
function CountedField({
  field,
  label,
  defaultValue,
  placeholder,
  error,
  required,
  multiline,
}: {
  field: WorkerFieldName;
  label: string;
  defaultValue?: string;
  placeholder: string;
  error?: string;
  required?: boolean;
  multiline?: boolean;
}) {
  const limit = workerFieldLimits[field];
  const [length, setLength] = useState(defaultValue?.length ?? 0);
  const over = length > limit;

  const countId = `${field}-count`;
  const errorId = `${field}-error`;

  const controlProps = {
    id: field,
    name: field,
    defaultValue,
    placeholder,
    required,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => setLength(event.target.value.length),
    // Both descriptions are announced, so the reason and the count are read
    // together rather than one replacing the other.
    "aria-describedby": error ? `${errorId} ${countId}` : countId,
    "aria-invalid": error ? (true as const) : undefined,
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-4">
        <Label htmlFor={field}>{label}</Label>
        <span
          id={countId}
          className={`text-xs tabular-nums ${
            over ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {length} / {limit}
        </span>
      </div>

      {multiline ? (
        <Textarea {...controlProps} rows={5} />
      ) : (
        <Input {...controlProps} />
      )}

      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
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
      <CountedField
        field="name"
        label="Name"
        required
        defaultValue={values.name}
        placeholder="Daily Website Update"
        error={errors.name}
      />

      <CountedField
        field="description"
        label="Description"
        defaultValue={values.description}
        placeholder="What does this worker do?"
        error={errors.description}
      />

      <CountedField
        field="prompt"
        label="Prompt"
        multiline
        defaultValue={values.prompt}
        placeholder="Instructions sent to the AI on every run."
        error={errors.prompt}
      />

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
