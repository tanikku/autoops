"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  runRoutineAction,
  type RunRoutineState,
} from "@/app/dashboard/actions";
import { useActionResult } from "@/components/notification/use-action-result";
import { Button } from "@/components/ui/button";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Running…" : "Run"}
    </Button>
  );
}

export function RunRoutineButton({ routineId }: { routineId: string }) {
  const [state, formAction] = useActionState<RunRoutineState, FormData>(
    runRoutineAction,
    null,
  );

  // Manual runs stay on the dashboard, so the toast is the only feedback.
  useActionResult(state);

  return (
    <form action={formAction}>
      <input type="hidden" name="routineId" value={routineId} />
      <SubmitButton />
    </form>
  );
}
