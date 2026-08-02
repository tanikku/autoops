"use client";

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

/**
 * Nulls are accepted so a rejected submission can be fed straight back in:
 * `readWorkerForm` reports an unrecognised status or frequency as null.
 */
export type WorkerFieldValues = {
  name?: string;
  description?: string;
  prompt?: string;
  schedule?: string;
  frequency?: RoutineFrequency | null;
  status?: RoutineStatus | null;
};

/**
 * Every editable field of a worker, shared by the hire and edit forms.
 *
 * Both forms render this rather than their own copy, so a field cannot exist
 * on one and be missing from the other — which is exactly how Description and
 * Schedule ended up creatable but not editable.
 *
 * Values are uncontrolled defaults: the forms submit through a server action,
 * which reads the FormData rather than component state.
 */
export function WorkerFields({ values }: { values: WorkerFieldValues }) {
  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          name="name"
          required
          defaultValue={values.name}
          placeholder="Daily Website Update"
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="description">Description</Label>
        <Input
          id="description"
          name="description"
          defaultValue={values.description}
          placeholder="What does this worker do?"
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="prompt">Prompt</Label>
        <Textarea
          id="prompt"
          name="prompt"
          rows={5}
          defaultValue={values.prompt}
          placeholder="Instructions sent to the AI on every run."
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="schedule">Schedule</Label>
        <Input
          id="schedule"
          name="schedule"
          defaultValue={values.schedule}
          placeholder="Every day at 07:00"
        />
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
