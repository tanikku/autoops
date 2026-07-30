"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  createRoutineAction,
  type CreateRoutineState,
} from "@/app/dashboard/new/actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { workerTemplates, type WorkerTemplate } from "@/lib/worker-templates";
import { routineFrequencies, routineStatuses } from "@/types";

const statusLabels: Record<(typeof routineStatuses)[number], string> = {
  active: "Active",
  paused: "Paused",
  draft: "Draft",
};

const frequencyLabels: Record<(typeof routineFrequencies)[number], string> = {
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

export function RoutineForm() {
  const [state, formAction] = useActionState<CreateRoutineState, FormData>(
    createRoutineAction,
    null,
  );
  const [template, setTemplate] = useState<WorkerTemplate | null>(null);

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
              onClick={() => setTemplate(item)}
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
        action={formAction}
        className="mt-8 flex max-w-2xl flex-col gap-6"
      >
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            name="name"
            required
            defaultValue={template?.name}
            placeholder="Daily Website Update"
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="description">Description</Label>
          <Input
            id="description"
            name="description"
            placeholder="What does this worker do?"
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="prompt">Prompt</Label>
          <Textarea
            id="prompt"
            name="prompt"
            rows={5}
            defaultValue={template?.defaultPrompt}
            placeholder="Instructions sent to the AI on every run."
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="schedule">Schedule</Label>
          <Input
            id="schedule"
            name="schedule"
            placeholder="Every day at 07:00"
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="frequency">Frequency</Label>
          <select
            id="frequency"
            name="frequency"
            defaultValue={template?.defaultFrequency ?? "manual"}
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
            defaultValue="draft"
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
    </>
  );
}
