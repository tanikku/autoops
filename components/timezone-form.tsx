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
import { t } from "@/lib/i18n";
import { supportedTimezones } from "@/lib/timezones";

function SaveButton({ language }: { language: string }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending}>
      {t(language, pending ? "common.saving" : "common.save")}
    </Button>
  );
}

export function TimezoneForm({
  timezone,
  language,
}: {
  timezone: string;
  /**
   * The language the labels are written in — the account's, as stored.
   *
   * **The zones themselves are not translated.** An IANA identifier is what
   * the column holds and what the scheduler reads; the list says the same
   * thing on both versions of this page.
   */
  language: string;
}) {
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
        <Label htmlFor="timezone-trigger">
          {t(language, "settings.timezone.title")}
        </Label>

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

        {/* **The sentence lives in the dictionary now**, and so does what
            every clause of it is held to — see `settings.timezone.note` in
            `lib/i18n/en.ts`. What it must not start describing, in any
            language, is what happens to the runs *after* the one already
            scheduled. */}
        <p className="text-sm text-muted-foreground">
          {t(language, "settings.timezone.note")}
        </p>
      </div>

      <div>
        <SaveButton language={language} />
      </div>
    </form>
  );
}
