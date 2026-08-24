"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  runRoutineAction,
  type RunRoutineState,
} from "@/app/dashboard/actions";
import { useActionResult } from "@/components/notification/use-action-result";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

function SubmitButton({ language }: { language: string }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? t(language, "worker.running") : t(language, "worker.run")}
    </Button>
  );
}

/**
 * **The button is translated; what the run says back is not, yet.** The toast
 * comes from the run action, which still answers in English — that is a server
 * action message, and those are a later day's work.
 */
export function RunRoutineButton({
  routineId,
  language,
}: {
  routineId: string;
  language: string;
}) {
  const [state, formAction] = useActionState<RunRoutineState, FormData>(
    runRoutineAction,
    null,
  );

  // Manual runs stay on the dashboard, so the toast is the only feedback.
  useActionResult(state);

  return (
    <form action={formAction}>
      <input type="hidden" name="routineId" value={routineId} />
      <SubmitButton language={language} />
    </form>
  );
}
