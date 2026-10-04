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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmailNotificationField, frequencyKeys } from "@/components/worker-fields";
import { t, type TranslationKey } from "@/lib/i18n";
import type { EmailEntitlement } from "@/lib/plans";
import { minutesToTimeValue } from "@/lib/worker-input";
import {
  type WatchTemplateId,
  watchTemplateFrequencies,
  watchTemplateLimits,
} from "@/lib/worker-template-compiler";
import { isIntervalFrequency, type RoutineFrequency } from "@/types";

/**
 * Hiring a worker by answering what it should wait for.
 *
 * **Answers only.** The form sends a template identifier, the person's answers
 * and the schedule, email and status every worker has; the server turns the
 * answers into the instructions and the condition. Nothing here writes a
 * prompt, a condition or a kind.
 *
 * **The same action as every other hire**, so starting a trial, the active
 * limit and the one-worker email switch behave exactly as they do elsewhere —
 * including the confirmation a refused email switch asks for.
 */

const selectClassName =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

const DEFAULT_RUN_AT = "09:00";

const copy: Record<
  WatchTemplateId,
  { title: TranslationKey; helper: TranslationKey; limitation: TranslationKey; url: TranslationKey }
> = {
  "hotel-availability": {
    title: "template.hotel.title",
    helper: "template.hotel.helper",
    limitation: "template.hotel.limitation",
    url: "template.hotel.field.url",
  },
  "product-restock": {
    title: "template.restock.title",
    helper: "template.restock.helper",
    limitation: "template.restock.limitation",
    url: "template.restock.field.url",
  },
};

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  ) : null;
}

function SubmitButtons({ language }: { language: string }) {
  const { pending } = useFormStatus();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* **Draft first in the document, start first on screen.** Pressing Enter
          in a field submits with the first button, and that must not be the
          one that switches a worker on — and may start a trial. */}
      <div className="flex flex-row-reverse justify-end gap-2">
        <Button type="submit" name="status" value="draft" variant="outline" disabled={pending}>
          {t(language, "template.common.saveDraft")}
        </Button>
        <Button type="submit" name="status" value="active" disabled={pending}>
          {t(language, pending ? "common.saving" : "template.common.start")}
        </Button>
      </div>
      <Button
        variant="ghost"
        nativeButton={false}
        render={<Link href="/dashboard/workers" />}
      >
        {t(language, "common.cancel")}
      </Button>
    </div>
  );
}

export function TemplateWatchForm({
  templateId,
  timezone,
  language,
  emailEntitlement,
  trialNote,
}: {
  templateId: WatchTemplateId;
  timezone: string;
  language: string;
  emailEntitlement?: EmailEntitlement;
  /** What starting the first worker does to the trial, said beside the button. */
  trialNote?: string | null;
}) {
  const [state, formAction] = useActionState<CreateRoutineState, FormData>(
    createRoutineAction,
    null,
  );
  const [attempt, setAttempt] = useState(0);
  useActionResult(state, { redirectTo: "/dashboard/workers" });

  const answers = state?.templateValues;
  const answerErrors = state?.templateErrors ?? {};
  const errors = state?.errors ?? {};
  const common = state?.values;
  const offered = watchTemplateFrequencies as readonly RoutineFrequency[];
  const [frequency, setFrequency] = useState<RoutineFrequency>(
    common?.frequency && offered.includes(common.frequency)
      ? common.frequency
      : watchTemplateFrequencies[0],
  );
  const interval = isIntervalFrequency(frequency);
  const hotel = templateId === "hotel-availability";
  const text = copy[templateId];

  return (
    <form
      // Remounting puts what was sent back into the fields after a refusal.
      key={attempt}
      action={(formData) => {
        setAttempt((count) => count + 1);
        formAction(formData);
      }}
      className="mt-8 flex max-w-2xl flex-col gap-6"
    >
      <input type="hidden" name="templateId" value={templateId} />

      <div className="grid gap-1">
        <h2 className="text-lg font-medium tracking-tight">{t(language, text.title)}</h2>
        <p className="text-sm text-muted-foreground">{t(language, text.helper)}</p>
        <p className="text-sm text-muted-foreground">{t(language, text.limitation)}</p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="websiteUrl">{t(language, text.url)}</Label>
        <Input
          id="websiteUrl"
          name="websiteUrl"
          type="url"
          required
          defaultValue={answers?.websiteUrl}
          placeholder="https://"
          aria-invalid={errors.websiteUrl ? true : undefined}
        />
        <FieldError id="websiteUrl-error" message={errors.websiteUrl} />
      </div>

      {hotel ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor="stayDate">{t(language, "template.hotel.field.stayDate")}</Label>
            <Input
              id="stayDate"
              name="stayDate"
              type="date"
              required
              defaultValue={answers?.stayDate}
              className="w-48"
              aria-invalid={answerErrors.stayDate ? true : undefined}
            />
            <FieldError id="stayDate-error" message={answerErrors.stayDate} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="room">{t(language, "template.hotel.field.room")}</Label>
            <Input
              id="room"
              name="room"
              maxLength={watchTemplateLimits.room}
              defaultValue={answers?.room}
              placeholder={t(language, "template.hotel.field.roomPlaceholder")}
            />
            <FieldError id="room-error" message={answerErrors.room} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="maxPrice">{t(language, "template.hotel.field.maxPrice")}</Label>
            <Input
              id="maxPrice"
              name="maxPrice"
              type="number"
              min={1}
              max={watchTemplateLimits.maxPrice}
              step={1}
              defaultValue={answers?.maxPrice}
              className="w-48"
            />
            <FieldError id="maxPrice-error" message={answerErrors.maxPrice} />
          </div>
        </>
      ) : (
        <>
          <div className="grid gap-2">
            <Label htmlFor="product">{t(language, "template.restock.field.product")}</Label>
            <Input
              id="product"
              name="product"
              required
              maxLength={watchTemplateLimits.product}
              defaultValue={answers?.product}
              aria-invalid={answerErrors.product ? true : undefined}
            />
            <FieldError id="product-error" message={answerErrors.product} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="variant">{t(language, "template.restock.field.variant")}</Label>
            <Input
              id="variant"
              name="variant"
              maxLength={watchTemplateLimits.variant}
              defaultValue={answers?.variant}
              placeholder={t(language, "template.restock.field.variantPlaceholder")}
            />
            <FieldError id="variant-error" message={answerErrors.variant} />
          </div>
          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <input
                id="includePreorder"
                name="includePreorder"
                type="checkbox"
                value="true"
                defaultChecked={answers?.includePreorder === "true"}
                className="size-4 rounded border-input accent-primary"
              />
              <Label htmlFor="includePreorder">
                {t(language, "template.restock.field.includePreorder")}
              </Label>
            </div>
            <FieldError id="includePreorder-error" message={answerErrors.includePreorder} />
          </div>
        </>
      )}

      <div className="grid gap-2">
        <Label htmlFor="notes">{t(language, "template.field.notes")}</Label>
        <Textarea
          id="notes"
          name="notes"
          rows={2}
          maxLength={watchTemplateLimits.notes}
          defaultValue={answers?.notes}
        />
        <FieldError id="notes-error" message={answerErrors.notes} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="name">{t(language, "template.field.name")}</Label>
        <Input id="name" name="name" maxLength={100} defaultValue={answers?.name} />
        <p className="text-xs text-muted-foreground">{t(language, "template.field.nameHelp")}</p>
        <FieldError id="name-error" message={errors.name} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="frequency">{t(language, "worker.field.frequency")}</Label>
        <select
          id="frequency"
          name="frequency"
          value={frequency}
          onChange={(event) => setFrequency(event.target.value as RoutineFrequency)}
          className={selectClassName}
        >
          {watchTemplateFrequencies.map((option) => (
            <option key={option} value={option}>
              {t(language, frequencyKeys[option])}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {t(language, "worker.field.frequencyAllowanceNote")}
        </p>
        <FieldError id="frequency-error" message={errors.frequency} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="runAt">
          {t(language, interval ? "worker.field.intervalRunAt" : "worker.field.runAt")}
        </Label>
        <Input
          id="runAt"
          name="runAt"
          type="time"
          required={interval}
          defaultValue={minutesToTimeValue(common?.runAtMinutes ?? null) ?? DEFAULT_RUN_AT}
          className="w-40"
          aria-invalid={errors.runAt ? true : undefined}
        />
        {interval ? (
          <p className="text-xs text-muted-foreground">
            {t(language, "worker.field.intervalNote")}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t(
            language,
            interval ? "worker.field.intervalTimezoneNote" : "worker.field.timezoneNote",
            { timezone },
          )}
        </p>
        <FieldError id="runAt-error" message={errors.runAt} />
      </div>

      <EmailNotificationField
        language={language}
        values={{ emailNotificationsEnabled: common?.emailNotificationsEnabled ?? false }}
        errors={errors}
        emailEntitlement={emailEntitlement}
        website
        label={t(language, "template.common.emailLabel")}
      />

      <FieldError id="status-error" message={errors.status} />
      {trialNote ? <p className="text-sm text-muted-foreground">{trialNote}</p> : null}
      <SubmitButtons language={language} />
    </form>
  );
}
