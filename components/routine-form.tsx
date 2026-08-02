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
  WorkerFields,
  type WorkerFieldValues,
} from "@/components/worker-fields";
import { workerTemplates, type WorkerTemplate } from "@/lib/worker-templates";

function SaveButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

export function RoutineForm() {
  const [state, formAction] = useActionState<CreateRoutineState, FormData>(
    createRoutineAction,
    null,
  );
  const [template, setTemplate] = useState<WorkerTemplate | null>(null);

  // Picking a template and recovering a rejected submission both want to fill
  // the fields, and the last one to happen should win. Holding the template's
  // values separately makes that order explicit: choosing sets them, and
  // submitting clears them so the action's result takes over.
  const [templateValues, setTemplateValues] =
    useState<WorkerFieldValues | null>(null);

  useActionResult(state, { redirectTo: "/dashboard" });

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
        // Remounting applies the selected template's values to the fields while
        // leaving every one of them editable.
        key={template?.id ?? "blank"}
        action={(formData) => {
          setTemplateValues(null);
          formAction(formData);
        }}
        className="mt-8 flex max-w-2xl flex-col gap-6"
      >
        <WorkerFields values={templateValues ?? state?.values ?? {}} />

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
