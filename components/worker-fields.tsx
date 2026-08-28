"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { t, type TranslationKey } from "@/lib/i18n";
import { weekdayKeys } from "@/lib/schedule-label";
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

/**
 * The stored values, as the person choosing one reads them.
 *
 * **The values are the contract and these are not.** `active` stays `active`
 * in the column, in the scheduler's `where`, and in the submitted form; a
 * language decides only what the option says about it.
 *
 * The status words are the dashboard's — a badge and a menu entry that say
 * different things about the same value would be two answers to one question.
 * `manual` borrows `worker.manual` for the same reason.
 */
const statusKeys: Record<RoutineStatus, TranslationKey> = {
  active: "common.status.active",
  paused: "common.status.paused",
  draft: "common.status.draft",
};

/**
 * Exported because the hire form's draft card names a cadence too, and two
 * lists would be two answers to the same question.
 */
export const frequencyKeys: Record<RoutineFrequency, TranslationKey> = {
  manual: "worker.manual",
  daily: "worker.frequency.daily",
  weekly: "worker.frequency.weekly",
  monthly: "worker.frequency.monthly",
};

const statusDescriptionKeys: Record<RoutineStatus, TranslationKey> = {
  draft: "worker.status.draftDescription",
  active: "worker.status.activeDescription",
  paused: "worker.status.pausedDescription",
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
  timezone,
  websiteUrlNote,
  language,
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
  /**
   * The zone this worker's schedule will be read in — the account's, as stored.
   *
   * **Required, and shown rather than implied.** "In your timezone" was already
   * here and was not enough: the account starts on UTC and nothing on this form
   * said so, so a time entered as 09:00 by someone reading their own wall clock
   * was stored as 09:00 somewhere else entirely. A worker scheduled that way is
   * wrong by the offset, silently, until somebody works out why it ran at the
   * wrong hour — which is what happened.
   *
   * The identifier is passed in rather than read here: this is a client
   * component, and the zone lives on the account row.
   */
  timezone: string;
  /**
   * The language the labels are written in — the account's, as stored.
   *
   * **Handed down rather than read here**, the same as the zone: this is a
   * client component, and the language lives on the account row. What is typed
   * into these fields is never touched by it. A Japanese form and an English
   * one submit the same values.
   */
  language: string;
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
        label={t(language, "worker.field.name")}
        required
        defaultValue={values.name}
        placeholder={t(language, "worker.field.namePlaceholder")}
        error={errors.name}
      />

      <CountedField
        field="description"
        label={t(language, "worker.field.description")}
        defaultValue={values.description}
        placeholder={t(language, "worker.field.descriptionPlaceholder")}
        error={errors.description}
      />

      {/* Between the description and the prompt because that is the order the
          worker is read in: what it is called, what it is for, where it looks,
          and then what to do about what it finds. */}
      {/* The example address is not translated: a URL is not language, and
          showing a different one per language would suggest it mattered. */}
      <CountedField
        field="websiteUrl"
        label={t(language, "worker.field.websiteUrl")}
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
        label={t(
          language,
          website ? "worker.field.changePrompt" : "worker.prompt",
        )}
        multiline
        defaultValue={values.prompt}
        placeholder={t(
          language,
          website
            ? "worker.field.changePromptPlaceholder"
            : "worker.field.promptPlaceholder",
        )}
        error={errors.prompt}
      />

      <div className="grid gap-2">
        <Label htmlFor="frequency">
          {t(language, "worker.field.frequency")}
        </Label>
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
              {t(language, frequencyKeys[option])}
            </option>
          ))}
        </select>
      </div>

      {/* Only a weekly worker has a week to place a day in. Rendering these
          conditionally also keeps them out of the submission: a manual worker
          sends no time, which is what the action stores. */}
      {frequency === "weekly" ? (
        <div className="grid gap-2">
          <Label htmlFor="runAtWeekday">
            {t(language, "worker.field.weekday")}
          </Label>
          <select
            id="runAtWeekday"
            name="runAtWeekday"
            defaultValue={values.runAtWeekday ?? ""}
            className={selectClassName}
          >
            <option value="">
              {t(language, "worker.field.sameWeekday")}
            </option>
            {weekdays.map((day) => (
              <option key={day.value} value={day.value}>
                {t(language, weekdayKeys[day.value])}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {frequency === "monthly" ? (
        <div className="grid gap-2">
          <Label htmlFor="runAtDay">
            {t(language, "worker.field.monthDay")}
          </Label>
          <select
            id="runAtDay"
            name="runAtDay"
            defaultValue={values.runAtDay ?? ""}
            className={selectClassName}
          >
            <option value="">
              {t(language, "worker.field.sameMonthDay")}
            </option>
            {/* Both forms of the date go out and each language takes the one
                it needs: "the 3rd" is an English rule. */}
            {monthDays.map((day) => (
              <option key={day} value={day}>
                {t(language, "worker.field.monthDayOption", {
                  ordinal: ordinal(day),
                  day,
                })}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {t(language, "worker.field.monthDayNote")}
          </p>
        </div>
      ) : null}

      {frequency !== "manual" ? (
        <div className="grid gap-2">
          <Label htmlFor="runAt">{t(language, "worker.field.runAt")}</Label>
          <Input
            id="runAt"
            name="runAt"
            type="time"
            defaultValue={values.runAt}
            className="w-40"
          />
          <p className="text-xs text-muted-foreground">
            {t(language, "worker.field.timezoneNote", { timezone })}
          </p>
        </div>
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor="status">{t(language, "common.statusLabel")}</Label>
        <select
          id="status"
          name="status"
          value={status}
          onChange={(event) => setStatus(event.target.value as RoutineStatus)}
          className={selectClassName}
        >
          {routineStatuses.map((option) => (
            <option key={option} value={option}>
              {t(language, statusKeys[option])}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {t(language, statusDescriptionKeys[status])}
        </p>
        {/* The account's active-worker limit is the one rule this control can
            break, and the message belongs next to the choice that broke it. */}
        {errors.status ? (
          <p id="status-error" className="text-sm text-destructive">
            {errors.status}
          </p>
        ) : null}
      </div>
    </>
  );
}
