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

        {/* **The last sentence says only what saving this does.** Saving writes
            one column — the account's zone — and nothing reads or rewrites a
            worker's pending slot on the way, so the run already scheduled stays
            exactly where it was.

            What happens to the runs *after* that one is deliberately not
            described here. It is not one rule: a worker with a Run at time has
            that time re-read in the new zone when its schedule next advances,
            while a worker with Run at left empty keeps the moment it already
            had. Any sentence short enough for this page would be wrong about
            one of the two. */}
        <p className="text-sm text-muted-foreground">
          Timestamps are shown in this zone, and a worker set to run at 09:00
          runs at 09:00 here. Changing the timezone does not change any
          worker&rsquo;s already-scheduled next run.
        </p>
      </div>

      <div>
        <SaveButton />
      </div>
    </form>
  );
}
