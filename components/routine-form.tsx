"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  createRoutineAction,
  type CreateRoutineState,
} from "@/app/dashboard/new/actions";
import { useActionResult } from "@/components/notification/use-action-result";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  useScrollToFirstError,
  WorkerFields,
  type WorkerFieldValues,
} from "@/components/worker-fields";
import { minutesToTimeValue } from "@/lib/worker-input";
import { workerTemplates, type WorkerTemplate } from "@/lib/worker-templates";
import type { RoutineKind } from "@/types";

/**
 * The two kinds, as the person choosing one reads them.
 *
 * Wording rather than jargon: `website` is the stored value, "Watch a page" is
 * the thing being decided. The second line says what each one needs from them,
 * because that is the difference that matters while filling the form in.
 */
const kindOptions: {
  value: RoutineKind;
  label: string;
  description: string;
}[] = [
  {
    value: "prompt",
    label: "Run a prompt",
    description: "Sends your instructions to the AI on a schedule.",
  },
  {
    value: "website",
    label: "Watch a page",
    description: "Checks a page and only involves the AI when it changes.",
  },
];

/**
 * Ties the kind radios to the form they belong to.
 *
 * They sit above it — the choice comes before the fields it changes — and the
 * `form` attribute is what makes a control outside a form submit with it, so
 * the layout does not have to be decided by the markup nesting.
 */
const FORM_ID = "hire-worker";

function SaveButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

export function RoutineForm({ timezone }: { timezone: string }) {
  const [state, formAction] = useActionState<CreateRoutineState, FormData>(
    createRoutineAction,
    null,
  );
  const [template, setTemplate] = useState<WorkerTemplate | null>(null);

  // **Held here rather than left to the form, because two things read it**: the
  // fields, which show an address box for one kind and not the other, and the
  // template list, which has nothing to offer the other kind.
  //
  // **It survives a rejected submission** — the form below remounts on every
  // submit, and state out here is what keeps a returning error from quietly
  // putting the form back to the kind nobody chose.
  //
  // Deliberately not part of the form's `key`: switching kind should change
  // which fields are on screen, not empty the ones already filled in.
  const [kind, setKind] = useState<RoutineKind>("prompt");

  // Picking a template and recovering a rejected submission both want to fill
  // the fields, and the last one to happen should win. Holding the template's
  // values separately makes that order explicit: choosing sets them, and
  // submitting clears them so the action's result takes over.
  const [templateValues, setTemplateValues] =
    useState<WorkerFieldValues | null>(null);

  // Bumped on every submit so the form remounts with the result. `defaultValue`
  // is read once at initialisation; feeding rejected input back through it on
  // a re-render changes it after the fact, which Base UI rejects.
  const [attempt, setAttempt] = useState(0);

  // Messages belong to the values that produced them: picking a template
  // replaces those values, so the messages go with them — and so does the jump
  // to the field they pointed at.
  const visibleErrors = templateValues ? undefined : state?.errors;

  useActionResult(state, { redirectTo: "/dashboard" });
  useScrollToFirstError(visibleErrors);

  function selectTemplate(item: WorkerTemplate) {
    setTemplate(item);
    setTemplateValues({
      name: item.name,
      prompt: item.defaultPrompt,
      frequency: item.defaultFrequency,
    });
  }

  return (
    <>
      <section className="mt-8 max-w-2xl">
        <h2 className="text-lg font-medium tracking-tight">
          What should this worker do?
        </h2>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {kindOptions.map((option) => (
            <label key={option.value} className="cursor-pointer">
              <input
                type="radio"
                name="kind"
                form={FORM_ID}
                value={option.value}
                checked={kind === option.value}
                onChange={() => setKind(option.value)}
                className="peer sr-only"
              />
              <Card
                size="sm"
                className="h-full peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 peer-checked:ring-2 peer-checked:ring-primary"
              >
                <CardHeader>
                  <CardTitle>{option.label}</CardTitle>
                  <CardDescription>{option.description}</CardDescription>
                </CardHeader>
              </Card>
            </label>
          ))}
        </div>
      </section>

      {/* **Templates are prompt workers**, every one of them: each is a name, a
          cadence and a prompt, and none of them names a page. Hiding the list
          rather than adding a kind to the template model keeps that a fact
          about what a template is, instead of a field every future template has
          to answer. */}
      <section className={kind === "website" ? "hidden" : "mt-8 max-w-2xl"}>
        <h2 className="text-lg font-medium tracking-tight">Choose a Template</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Start from a template, or fill in the form below yourself.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {workerTemplates.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={template?.id === item.id}
              onClick={() => selectTemplate(item)}
              className="rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <Card
                size="sm"
                className={
                  template?.id === item.id
                    ? "h-full ring-2 ring-primary"
                    : "h-full"
                }
              >
                <CardHeader>
                  <CardTitle>{item.name}</CardTitle>
                  <CardDescription>{item.description}</CardDescription>
                </CardHeader>
              </Card>
            </button>
          ))}
        </div>
      </section>

      <form
        id={FORM_ID}
        // Remounting applies the selected template's values to the fields while
        // leaving every one of them editable.
        key={`${template?.id ?? "blank"}-${attempt}`}
        action={(formData) => {
          setTemplateValues(null);
          setAttempt((count) => count + 1);
          formAction(formData);
        }}
        className="mt-8 flex max-w-2xl flex-col gap-6"
      >
        <WorkerFields
          values={
            templateValues ??
            (state?.values
              ? {
                  ...state.values,
                  runAt: minutesToTimeValue(state.values.runAtMinutes),
                  runAtWeekday: state.values.runAtWeekday,
                  runAtDay: state.values.runAtDay,
                }
              : {})
          }
          errors={visibleErrors}
          kind={kind}
          timezone={timezone}
        />

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
    </>
  );
}
