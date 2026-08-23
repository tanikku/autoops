import type { WorkerFieldValues } from "@/components/worker-fields";
import type { WorkerDraft } from "@/lib/ai/worker-draft";
import { minutesToTimeValue } from "@/lib/worker-input";
import type { RoutineStatus } from "@/types";
import type { WorkerTemplate } from "@/lib/worker-templates";

/**
 * Values waiting to be put into the hire form, and where they came from.
 *
 * **One box for every source, because there is only ever one answer.** A
 * template and an AI draft both want to fill the same fields, and holding them
 * apart would mean writing down which wins at every place that reads them. Held
 * together, "the last one applied wins" is not a rule anybody has to remember —
 * it is what assignment already does.
 *
 * **`token` is what makes the values appear.** The fields are uncontrolled, so
 * `defaultValue` is read once when they mount and never again; putting the
 * token in the form's `key` is what remounts them. New values without a new
 * token change nothing on screen — the form would keep whatever was in it, and
 * the failure would be silent.
 */
export type InjectedValues = {
  token: string;
  source: "template" | "draft";
  values: WorkerFieldValues;
};

/**
 * A draft as form values, field by field.
 *
 * **Named rather than spread**, and that is the point of the function. A draft
 * is what a model proposed; the form is what somebody is about to save. Copying
 * one into the other wholesale would mean any field added to `WorkerDraft`
 * later arrives in the form without anybody deciding it should — which is the
 * same mistake `toRoutine` avoids by naming every column it lets out.
 *
 * **`status` does not come from the draft**, because no draft has one. It is
 * carried through from what the person had already chosen, so applying a draft
 * answers the questions the model was asked and leaves alone the one it was
 * not. See `RoutineForm` for where the current value is read.
 *
 * `timezone` is not here either: it belongs to the account, arrives as a prop
 * from the server, and no value on this page can change it.
 */
export function draftToFieldValues(
  draft: WorkerDraft,
  status: RoutineStatus | undefined,
): WorkerFieldValues {
  return {
    name: draft.name,
    description: draft.description,
    prompt: draft.prompt,
    frequency: draft.frequency,
    runAt: minutesToTimeValue(draft.runAtMinutes),
    runAtWeekday: draft.runAtWeekday,
    runAtDay: draft.runAtDay,
    // Only one kind has an address, and a prompt worker must not carry one:
    // `undefined` leaves the field empty rather than holding a page nobody
    // asked this worker to watch.
    websiteUrl: draft.kind === "website" ? draft.websiteUrl : undefined,
    status,
  };
}

/** A draft, ready to be applied. The caller supplies the token. */
export function injectDraft(
  draft: WorkerDraft,
  status: RoutineStatus | undefined,
  token: string,
): InjectedValues {
  return {
    token,
    source: "draft",
    values: draftToFieldValues(draft, status),
  };
}

/**
 * A template, ready to be applied.
 *
 * **Carries no status, which is what it did before.** A template has never set
 * one, so the form falls back to its own default when one is chosen — existing
 * behaviour, deliberately left alone. The draft path preserves the current
 * status because that is what this change is about; making templates do the
 * same is a separate decision about a separate path.
 */
export function injectTemplate(
  template: WorkerTemplate,
  token: string,
): InjectedValues {
  return {
    token,
    source: "template",
    values: {
      name: template.name,
      prompt: template.defaultPrompt,
      frequency: template.defaultFrequency,
    },
  };
}

/**
 * A token nothing else will produce.
 *
 * The count is what separates two applications of the same source: applying the
 * same template twice should fill the fields twice, and a token built only from
 * its id would leave the second press doing nothing at all.
 */
export function injectionToken(source: InjectedValues["source"], count: number): string {
  return `${source}-${count}`;
}
