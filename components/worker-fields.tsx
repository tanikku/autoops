"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  workerFieldLimits,
  type WorkerFieldErrors,
  type WorkerFieldName,
} from "@/lib/worker-input";
import {
  monthDays,
  ordinal,
  routineFrequencies,
  routineStatuses,
  weekdays,
  type RoutineFrequency,
  type RoutineKind,
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

const statusDescriptions: Record<RoutineStatus, string> = {
  draft: "Draft workers are not scheduled. Set Status to Active to run automatically.",
  active: "Runs automatically according to its schedule.",
  paused: "Scheduled runs are paused. Manual runs still work.",
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
  websiteUrl?: string;
  frequency?: RoutineFrequency | null;
  status?: RoutineStatus | null;
  /** `HH:mm`, as an `<input type="time">` carries it. */
  runAt?: string;
  /** 0 (Sunday) to 6 (Saturday), or null for no particular day. */
  runAtWeekday?: number | null;
  /** 1 to 31, or null for no particular day. */
  runAtDay?: number | null;
};

/**
 * The order `WorkerFields` renders these in, which is what makes "the first
 * error" mean the topmost one on screen rather than whichever the validator
 * happened to record first.
 *
 * Kept beside the markup deliberately: reordering the fields without
 * reordering this list would send the user to the wrong one.
 */
const fieldOrder: WorkerFieldName[] = [
  "name",
  "description",
  "websiteUrl",
  "prompt",
];

/**
 * Brings the first rejected field into view and focuses it.
 *
 * A toast at the top of the screen says something is wrong; on a form long
 * enough to scroll, it does not say *where*. This closes that gap.
 *
 * Reaches for the element by id rather than threading refs through
 * `WorkerFields`: the ids already exist to tie labels and messages to their
 * inputs, so nothing new has to be managed to find them.
 *
 * A successful submit returns no errors and nothing moves.
 */
export function useScrollToFirstError(errors: WorkerFieldErrors | undefined) {
  useEffect(() => {
    if (!errors) {
      return;
    }

    const field = fieldOrder.find((name) => errors[name]);
    if (!field) {
      return;
    }

    const element = document.getElementById(field);
    if (!element) {
      return;
    }

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    // Waiting a frame: the form remounts on submit, and starting a scroll
    // before that layout settles leaves it measuring the old one.
    const frame = requestAnimationFrame(() => {
      // Focus first, and without a scroll of its own — a focus landing
      // mid-animation cancels the scroll and drops the field wherever the
      // browser prefers, usually the very edge of the viewport.
      element.focus({ preventScroll: true });

      element.scrollIntoView({
        block: "center",
        behavior: reducedMotion ? "auto" : "smooth",
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [errors]);
}

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
  hidden,
}: {
  field: WorkerFieldName;
  label: string;
  defaultValue?: string;
  placeholder: string;
  error?: string;
  required?: boolean;
  multiline?: boolean;
  /**
   * Kept in the page but out of sight, rather than removed.
   *
   * **An unmounted field forgets what was typed in it.** The address box
   * belongs to one kind of worker, and someone who types an address, looks at
   * the other kind, and comes back should find it still there — unmounting
   * would hand them an empty box and no explanation. `display: none` also takes
   * it out of the accessibility tree, so nothing reads out a field that is not
   * on screen.
   *
   * It is still submitted, which is safe because `readWorkerForm` drops an
   * address on any submission that is not creating a website worker.
   */
  hidden?: boolean;
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
    <div className={hidden ? "hidden" : "grid gap-2"}>
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
  kind = "prompt",
  websiteUrlNote,
}: {
  values: WorkerFieldValues;
  errors?: WorkerFieldErrors;
  /**
   * What the worker being described does, which changes two fields.
   *
   * **Defaulted, so the edit form is unaffected.** A kind cannot be changed
   * after a worker exists, and the edit form neither renders a selector nor
   * submits the field; leaving the default here is what keeps that form
   * rendering exactly as it did.
   */
  kind?: RoutineKind;
  /**
   * Something the caller needs said about changing the address.
   *
   * **Passed in rather than written here, because it is only true in one
   * place.** Editing an address abandons a comparison that already exists;
   * hiring a worker has nothing to abandon, so the same sentence on the create
   * form would describe a consequence that cannot happen. Shown only for a
   * website worker, which is the only kind with an address at all.
   */
  websiteUrlNote?: string;
}) {
  // The only controlled field, and only because another one depends on it: a
  // time of day is meaningless for a manual worker, so the select has to be
  // readable while the form is being filled in.
  const [frequency, setFrequency] = useState<RoutineFrequency>(
    values.frequency ?? "manual",
  );

  // Controlled for the same reason as frequency: the description below the
  // select has to track whatever is currently chosen, not just what the form
  // was initialised with.
  const [status, setStatus] = useState<RoutineStatus>(
    values.status ?? "draft",
  );

  const website = kind === "website";

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

      {/* Between the description and the prompt because that is the order the
          worker is read in: what it is called, what it is for, where it looks,
          and then what to do about what it finds. */}
      <CountedField
        field="websiteUrl"
        label="Website address"
        hidden={!website}
        defaultValue={values.websiteUrl}
        placeholder="https://example.com/news"
        error={errors.websiteUrl}
      />

      {website && websiteUrlNote ? (
        <p className="-mt-4 text-xs text-muted-foreground">{websiteUrlNote}</p>
      ) : null}

      {/* **The prompt means something different for each kind**, so it is asked
          for differently. A prompt worker's prompt is the whole job. A website
          worker's runs only after a change has been found, with the old and new
          text already in front of the model — asking for "instructions sent on
          every run" there would invite a description of the page rather than of
          what to do about it. */}
      <CountedField
        field="prompt"
        label={website ? "When the page changes" : "Prompt"}
        multiline
        defaultValue={values.prompt}
        placeholder={
          website
            ? "What should the AI do when this page changes?"
            : "Instructions sent to the AI on every run."
        }
        error={errors.prompt}
      />

      <div className="grid gap-2">
        <Label htmlFor="frequency">Frequency</Label>
        <select
          id="frequency"
          name="frequency"
          value={frequency}
          onChange={(event) =>
            setFrequency(event.target.value as RoutineFrequency)
          }
          className={selectClassName}
        >
          {routineFrequencies.map((option) => (
            <option key={option} value={option}>
              {frequencyLabels[option]}
            </option>
          ))}
        </select>
      </div>

      {/* Only a weekly worker has a week to place a day in. Rendering these
          conditionally also keeps them out of the submission: a manual worker
          sends no time, which is what the action stores. */}
      {frequency === "weekly" ? (
        <div className="grid gap-2">
          <Label htmlFor="runAtWeekday">Day</Label>
          <select
            id="runAtWeekday"
            name="runAtWeekday"
            defaultValue={values.runAtWeekday ?? ""}
            className={selectClassName}
          >
            <option value="">Same day it was saved</option>
            {weekdays.map((day) => (
              <option key={day.value} value={day.value}>
                {day.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {frequency === "monthly" ? (
        <div className="grid gap-2">
          <Label htmlFor="runAtDay">Day</Label>
          <select
            id="runAtDay"
            name="runAtDay"
            defaultValue={values.runAtDay ?? ""}
            className={selectClassName}
          >
            <option value="">Same day it was saved</option>
            {monthDays.map((day) => (
              <option key={day} value={day}>
                {ordinal(day)}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Days past the end of a month run on the last day instead.
          </p>
        </div>
      ) : null}

      {frequency !== "manual" ? (
        <div className="grid gap-2">
          <Label htmlFor="runAt">Run at</Label>
          <Input
            id="runAt"
            name="runAt"
            type="time"
            defaultValue={values.runAt}
            className="w-40"
          />
          <p className="text-xs text-muted-foreground">
            In your timezone. Leave empty to run at whatever time the worker
            was saved.
          </p>
        </div>
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor="status">Status</Label>
        <select
          id="status"
          name="status"
          value={status}
          onChange={(event) => setStatus(event.target.value as RoutineStatus)}
          className={selectClassName}
        >
          {routineStatuses.map((option) => (
            <option key={option} value={option}>
              {statusLabels[option]}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {statusDescriptions[status]}
        </p>
      </div>
    </>
  );
}
