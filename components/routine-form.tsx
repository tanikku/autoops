"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  createRoutineAction,
  generateWorkerDraftAction,
  type CreateRoutineState,
  type WorkerDraftState,
} from "@/app/dashboard/new/actions";
import { useActionResult } from "@/components/notification/use-action-result";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  injectDraft,
  injectionToken,
  injectTemplate,
  type InjectedValues,
} from "@/components/worker-draft-form";
import {
  useScrollToFirstError,
  WorkerFields,
} from "@/components/worker-fields";
import type { WorkerDraft } from "@/lib/ai/worker-draft";
import { minutesToTimeValue } from "@/lib/worker-input";
import { workerTemplates, type WorkerTemplate } from "@/lib/worker-templates";
import { isRoutineStatus, type RoutineKind, type RoutineStatus } from "@/types";

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

  // **One box, whatever filled it.** A template and an applied draft both want
  // the same fields, so they share the state that holds them: applying either
  // replaces the other, and "the last one wins" needs no rule of its own.
  // Submitting clears it so the action's result takes over.
  const [injected, setInjected] = useState<InjectedValues | null>(null);

  // What separates one application from the next. Applying the same template
  // twice has to fill the fields twice, and a token built from its id alone
  // would leave the second press changing nothing.
  const [injections, setInjections] = useState(0);

  // Bumped on every submit so the form remounts with the result. `defaultValue`
  // is read once at initialisation; feeding rejected input back through it on
  // a re-render changes it after the fact, which Base UI rejects.
  const [attempt, setAttempt] = useState(0);

  // **Drafting is a second action on the same page**, with its own pending
  // state and its own result. It is deliberately not passed to
  // `useActionResult`: that raises a toast for every result and navigates on
  // success, and a draft neither travels nor is finished.
  const [draftState, generateDraft, drafting] = useActionState<
    WorkerDraftState,
    FormData
  >(generateWorkerDraftAction, null);

  // Messages belong to the values that produced them: filling the fields from
  // somewhere else replaces those values, so the messages go with them — and so
  // does the jump to the field they pointed at.
  const visibleErrors = injected ? undefined : state?.errors;

  useActionResult(state, { redirectTo: "/dashboard" });
  useScrollToFirstError(visibleErrors);

  /**
   * The status the form is showing right now.
   *
   * **Read from the form rather than held up here.** The fields are
   * uncontrolled and the status select owns its own state; lifting it out to
   * survive one button would turn a form that submits what it shows into a
   * form that shows what this component remembers. The ids already exist to tie
   * labels to inputs — `useScrollToFirstError` reaches for them the same way.
   *
   * Undefined when the form is not there to ask, which leaves the field on its
   * own default.
   */
  function currentStatus(): RoutineStatus | undefined {
    const form = document.getElementById(FORM_ID);

    if (!(form instanceof HTMLFormElement)) {
      return undefined;
    }

    const value = String(new FormData(form).get("status") ?? "");
    return isRoutineStatus(value) ? value : undefined;
  }

  function apply(next: InjectedValues) {
    setInjected(next);
    setInjections((count) => count + 1);
  }

  function selectTemplate(item: WorkerTemplate) {
    setTemplate(item);
    apply(injectTemplate(item, injectionToken("template", injections)));
  }

  /**
   * Puts a draft into the fields, when the person says so.
   *
   * **Never on arrival.** Drafting takes seconds, and in those seconds somebody
   * may have typed. Applying what came back the moment it lands would overwrite
   * work that was in progress, so the write happens on a press instead: the
   * generation and the change to the form are two separate acts.
   *
   * The kind follows the draft because the fields depend on it — and the
   * selector stays where it is, so a wrong classification is one click from
   * being corrected.
   */
  function applyDraft(draft: WorkerDraft) {
    setTemplate(null);
    setKind(draft.kind);
    apply(injectDraft(draft, currentStatus(), injectionToken("draft", injections)));
  }

  return (
    <>
      {/* **The first thing on the page, and the only optional one.** Describing
          the job in a sentence is the shortest route to a worker; the kind
          selector, the templates and the form below are all still here for
          somebody who would rather fill them in. It sits above the kind
          selector because the draft decides the kind — asking first and then
          answering would be the wrong way round. */}
      <section className="mt-8 max-w-2xl">
        <h2 className="text-lg font-medium tracking-tight">
          What would you like AutoOps to handle?
        </h2>

        <form action={generateDraft} className="mt-4 flex flex-col gap-3">
          <Textarea
            id="request"
            name="request"
            rows={3}
            placeholder="Check this page every day and summarise anything important that changed."
            aria-describedby="request-result"
          />

          <div>
            <Button type="submit" variant="outline" disabled={drafting}>
              {drafting ? "Drafting…" : "Create draft"}
            </Button>
          </div>
        </form>

        {/* **What came back, where it was asked for.** A toast would carry the
            answer away while the person was still reading it, and two of the
            three answers are things to read rather than things that went
            wrong. */}
        <div id="request-result" aria-live="polite">
          {draftState?.status === "supported" ? (
            <Card size="sm" className="mt-4">
              <CardHeader>
                <CardTitle>{draftState.draft.name}</CardTitle>
                <CardDescription>
                  {draftState.draft.kind === "website"
                    ? `Watches ${draftState.draft.websiteUrl}`
                    : "Sends its instructions to the AI"}
                  {draftState.draft.frequency === "manual"
                    ? " · runs when you ask"
                    : ` · ${draftState.draft.frequency}`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => applyDraft(draftState.draft)}
                >
                  Apply to form
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {/* Neither of these is a failure: one is work AutoOps cannot do yet,
              the other is a question. Both read as information rather than as
              something broken. */}
          {draftState?.status === "unsupported" ? (
            <p className="mt-4 text-sm text-muted-foreground">
              {draftState.reason}
            </p>
          ) : null}

          {draftState?.status === "needs_input" ? (
            <p className="mt-4 text-sm text-muted-foreground">
              {draftState.message}
            </p>
          ) : null}

          {draftState?.status === "error" ? (
            <p className="mt-4 text-sm text-destructive">{draftState.message}</p>
          ) : null}
        </div>
      </section>

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
        key={`${injected?.token ?? "blank"}-${attempt}`}
        action={(formData) => {
          setInjected(null);
          setAttempt((count) => count + 1);
          formAction(formData);
        }}
        className="mt-8 flex max-w-2xl flex-col gap-6"
      >
        <WorkerFields
          values={
            injected?.values ??
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
