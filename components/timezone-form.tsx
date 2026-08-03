"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  updateTimezoneAction,
  type UpdateTimezoneState,
} from "@/app/dashboard/settings/actions";
import { useActionResult } from "@/components/notification/use-action-result";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supportedTimezones } from "@/lib/timezones";

function SaveButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

export function TimezoneForm({ timezone }: { timezone: string }) {
  const [state, formAction] = useActionState<UpdateTimezoneState, FormData>(
    updateTimezoneAction,
    null,
  );

  // The select is controlled because it has to submit through a hidden input:
  // this one renders a listbox rather than a native <select>, so its value is
  // not part of the form on its own.
  const [selected, setSelected] = useState(timezone);

  // Settings has nowhere to go afterwards, so the toast is the only feedback.
  useActionResult(state);

  return (
    <form action={formAction} className="mt-8 flex max-w-md flex-col gap-6">
      <div className="grid gap-2">
        <Label htmlFor="timezone-trigger">Timezone</Label>

        <input type="hidden" name="timezone" value={selected} />

        <Select
          value={selected}
          onValueChange={(value) => setSelected(String(value))}
          items={supportedTimezones}
        >
          <SelectTrigger id="timezone-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {supportedTimezones.map((zone) => (
              <SelectItem key={zone.value} value={zone.value}>
                {zone.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <p className="text-sm text-muted-foreground">
          Timestamps are shown in this zone, and a worker set to run at 09:00
          runs at 09:00 here.
        </p>
      </div>

      <div>
        <SaveButton />
      </div>
    </form>
  );
}
