"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  updateLanguageAction,
  type UpdateLanguageState,
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
import { supportedLanguages, t, type Language } from "@/lib/i18n";

/**
 * What each language is called in the menu.
 *
 * Read through `t` rather than held as data, because the two options are not
 * labelled the same way in both dictionaries — see `ja.ts` for why "Japanese"
 * and「日本語」are not the same choice to the two readers.
 */
const optionKeys = {
  en: "settings.language.english",
  ja: "settings.language.japanese",
} as const;

function SaveButton({ language }: { language: string }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending}>
      {pending
        ? t(language, "settings.language.saving")
        : t(language, "settings.language.save")}
    </Button>
  );
}

/**
 * The language switch, beside the timezone one rather than folded into it.
 *
 * **Its own form and its own save.** Two settings that happen to share a page
 * are still two settings: joined, a single result would have to describe two
 * writes, and there is nothing sensible for it to say when one lands and the
 * other does not.
 *
 * **Rendered in the language currently stored**, which is what makes the change
 * visible: saving revalidates the dashboard layout, the page is read again with
 * the new value, and this form comes back speaking it.
 */
export function LanguageForm({ language }: { language: Language }) {
  const [state, formAction] = useActionState<UpdateLanguageState, FormData>(
    updateLanguageAction,
    null,
  );

  // Controlled for the same reason the timezone select is: this renders a
  // listbox rather than a native <select>, so its value reaches the form
  // through the hidden input below rather than on its own.
  const [selected, setSelected] = useState<string>(language);

  // Settings has nowhere to go afterwards, so the toast is the only feedback.
  useActionResult(state);

  const items = supportedLanguages.map((value) => ({
    value,
    label: t(language, optionKeys[value]),
  }));

  return (
    <form action={formAction} className="mt-8 flex max-w-md flex-col gap-6">
      <div className="grid gap-2">
        <Label htmlFor="language-trigger">
          {t(language, "settings.language.label")}
        </Label>

        <input type="hidden" name="language" value={selected} />

        <Select
          value={selected}
          onValueChange={(value) => setSelected(String(value))}
          items={items}
        >
          <SelectTrigger id="language-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* **What it changes, and what it leaves alone.** This is the product's
            own words. A worker's instructions, the pages it watches and
            whatever a model writes back are the owner's material, and none of
            it is translated to match — somebody reading a Japanese dashboard
            while running a worker that summarises English news is doing what
            this separation is for. */}
        <p className="text-sm text-muted-foreground">
          {t(language, "settings.language.description")}
        </p>
      </div>

      <div>
        <SaveButton language={language} />
      </div>
    </form>
  );
}
