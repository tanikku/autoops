"use client";

import { useState } from "react";
import { RoutineForm } from "@/components/routine-form";
import { TemplateWatchForm } from "@/components/template-watch-form";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { t, type TranslationKey } from "@/lib/i18n";
import type { EmailEntitlement } from "@/lib/plans";

/**
 * Hiring a worker, starting from what Koqentra can be handed.
 *
 * **Shortcuts in front of the forms that were already here.** The first screen
 * names the three kinds of work a worker does — recurring AI work, watching a
 * web page, finding YouTube videos — plus the full builder. Each shortcut opens
 * an existing form: the generic form with an existing example applied, the
 * hotel and restock template forms, or the whole previous screen under "Build
 * your own". Nothing is drafted or fetched by choosing a card.
 */

export type CreationPurpose =
  | "ai"
  | "web"
  | "youtube"
  | "free"
  | "price"
  | "hotel"
  | "restock"
  | "website";

type Choice = { value: CreationPurpose; title: TranslationKey; description: TranslationKey };

const topLevel: Choice[] = [
  { value: "ai", title: "create.purpose.ai.title", description: "create.purpose.ai.description" },
  { value: "web", title: "create.purpose.web.title", description: "create.purpose.web.description" },
  {
    value: "youtube",
    title: "create.purpose.youtube.title",
    description: "create.purpose.youtube.description",
  },
  { value: "free", title: "create.purpose.free.title", description: "create.purpose.free.description" },
];

const webChoices: Choice[] = [
  { value: "price", title: "create.purpose.price.title", description: "create.purpose.price.description" },
  { value: "hotel", title: "create.purpose.hotel.title", description: "create.purpose.hotel.description" },
  {
    value: "restock",
    title: "create.purpose.restock.title",
    description: "create.purpose.restock.description",
  },
  {
    value: "website",
    title: "create.purpose.website.title",
    description: "create.purpose.website.description",
  },
];

/** The web purposes, which go back to the web choices rather than the top. */
const webPurposes: CreationPurpose[] = ["price", "hotel", "restock", "website"];

function ChoiceCards({
  language,
  heading,
  choices,
  onChoose,
}: {
  language: string;
  heading: TranslationKey;
  choices: Choice[];
  onChoose: (value: CreationPurpose) => void;
}) {
  return (
    <section className="mt-8 max-w-2xl">
      <h2 className="text-lg font-medium tracking-tight">{t(language, heading)}</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {choices.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => onChoose(item.value)}
            className="rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Card size="sm" className="h-full">
              <CardHeader>
                <CardTitle>{t(language, item.title)}</CardTitle>
                <CardDescription>{t(language, item.description)}</CardDescription>
              </CardHeader>
            </Card>
          </button>
        ))}
      </div>
    </section>
  );
}

export function CreateWorkerFlow({
  timezone,
  language,
  emailEntitlement,
  trialNote,
  initialPurpose = null,
}: {
  timezone: string;
  language: string;
  emailEntitlement?: EmailEntitlement;
  /**
   * What activating the first worker does to the trial, already worded, or
   * null when there is nothing to say. Shown beside the template forms' start
   * button and above everything else.
   */
  trialNote?: string | null;
  /** Which purpose is open first. Null shows the first choice. */
  initialPurpose?: CreationPurpose | null;
}) {
  const [purpose, setPurpose] = useState<CreationPurpose | null>(initialPurpose);
  const template = purpose === "hotel" || purpose === "restock";
  const inWeb = purpose !== null && webPurposes.includes(purpose);
  const formProps = { timezone, language, emailEntitlement };

  return (
    <>
      {trialNote && !template ? (
        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
          <p className="text-sm text-muted-foreground">{trialNote}</p>
        </div>
      ) : null}

      {purpose === null ? (
        <ChoiceCards
          language={language}
          heading="create.purpose.heading"
          choices={topLevel}
          onChoose={setPurpose}
        />
      ) : (
        <div className="mt-6">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPurpose(inWeb ? "web" : null)}
          >
            {t(language, inWeb ? "create.purpose.backToWeb" : "create.purpose.back")}
          </Button>
        </div>
      )}

      {purpose === "web" ? (
        <ChoiceCards
          language={language}
          heading="create.purpose.web.heading"
          choices={webChoices}
          onChoose={setPurpose}
        />
      ) : null}

      {/* An existing example, applied as choosing it from the list would. */}
      {purpose === "ai" ? (
        <RoutineForm {...formProps} mode="prompt" initialTemplateId="idea-generator" />
      ) : null}

      {purpose === "youtube" ? (
        <>
          <p className="mt-6 max-w-2xl text-sm text-muted-foreground">
            {t(language, "create.purpose.youtube.note")}
          </p>
          <RoutineForm {...formProps} mode="discovery" initialTemplateId="recommendation-finder" />
        </>
      ) : null}

      {purpose === "price" ? (
        <RoutineForm {...formProps} mode="website" initialTemplateId="product-page" />
      ) : null}

      {purpose === "hotel" || purpose === "restock" ? (
        <TemplateWatchForm
          {...formProps}
          templateId={purpose === "hotel" ? "hotel-availability" : "product-restock"}
          trialNote={trialNote}
        />
      ) : null}

      {purpose === "website" ? <RoutineForm {...formProps} mode="website" /> : null}

      {purpose === "free" ? <RoutineForm {...formProps} mode="free" /> : null}
    </>
  );
}
