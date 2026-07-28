"use client";

import { useFormStatus } from "react-dom";
import { runRoutineAction } from "@/app/dashboard/actions";
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
  return (
    <form action={runRoutineAction}>
      <input type="hidden" name="routineId" value={routineId} />
      <SubmitButton />
    </form>
  );
}
