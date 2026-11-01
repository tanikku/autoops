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
 * leads with the two jobs a newcomer recognises — watching a web page and
 * recurring AI work — then three recommended page watches, and keeps every
 * other way in (hotel, restock, any page, YouTube, the full builder) one click
 * away under "other uses". Each shortcut opens an existing form: the generic
 * form with an existing example applied, the hotel and restock template forms,
 * or the whole previous screen under "Build your own". Nothing is drafted or
 * fetched by choosing a card, and nothing was taken away — only reordered.
 */

export type CreationPurpose =
  | "ai"
  | "web"
  | "municipal"
  | "careers"
  | "youtube"
  | "free"
  | "price"
  | "hotel"
  | "restock"
  | "website";

type Choice = { value: CreationPurpose; title: TranslationKey; description: TranslationKey };

/** Web watching first: it is what a newcomer is most likely to come for. */
const primary: Choice[] = [
  { value: "web", title: "create.purpose.web.title", description: "create.purpose.web.description" },
  { value: "ai", title: "create.purpose.ai.title", description: "create.purpose.ai.description" },
];

/** Three page watches, each an existing website example. */
const recommended: Choice[] = [
  {
    value: "municipal",
    title: "create.purpose.municipal.title",
    description: "create.purpose.municipal.description",
  },
  { value: "price", title: "create.purpose.price.title", description: "create.purpose.price.description" },
  {
    value: "careers",
    title: "create.purpose.careers.title",
    description: "create.purpose.careers.description",
  },
];

/** Every other way in, kept rather than removed. */
const otherChoices: Choice[] = [
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
  {
    value: "youtube",
    title: "create.purpose.youtube.title",
    description: "create.purpose.youtube.description",
  },
  { value: "free", title: "create.purpose.free.title", description: "create.purpose.free.description" },
];

const webChoices: Choice[] = [
  ...recommended,
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
const webPurposes: CreationPurpose[] = [
  "municipal",
  "price",
  "careers",
  "hotel",
  "restock",
  "website",
];

/** The existing website example each recommended watch applies. */
const websiteExample: Partial<Record<CreationPurpose, string>> = {
  municipal: "municipal-notices",
  price: "product-page",
  careers: "careers-page",
};

function CardGrid({
  language,
  choices,
  onChoose,
  large = false,
}: {
  language: string;
  choices: Choice[];
  onChoose: (value: CreationPurpose) => void;
  large?: boolean;
}) {
  return (
    <div className={`grid gap-3 ${large ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
      {choices.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => onChoose(item.value)}
          className="rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Card size={large ? "default" : "sm"} className="h-full transition-colors hover:bg-muted/40">
            <CardHeader>
              <CardTitle className={large ? "text-base sm:text-lg" : undefined}>
                {t(language, item.title)}
              </CardTitle>
              <CardDescription>{t(language, item.description)}</CardDescription>
            </CardHeader>
          </Card>
        </button>
      ))}
    </div>
  );
}

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
      <div className="mt-4">
        <CardGrid language={language} choices={choices} onChoose={onChoose} large />
      </div>
    </section>
  );
}

/**
 * The opening screen.
 *
 * **"Other uses" is a native `<details>`**, so it opens with Enter or Space
 * without script or a new dependency; its cards are in the document either way.
 */
function FirstChoice({
  language,
  onChoose,
}: {
  language: string;
  onChoose: (value: CreationPurpose) => void;
}) {
  return (
    <div className="mt-8 max-w-3xl">
      <section>
        <h2 className="text-lg font-medium tracking-tight">
          {t(language, "create.purpose.heading")}
        </h2>
        <div className="mt-4">
          <CardGrid language={language} choices={primary} onChoose={onChoose} large />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-base font-medium tracking-tight">
          {t(language, "create.purpose.recommended.heading")}
        </h2>
        <div className="mt-3">
          <CardGrid language={language} choices={recommended} onChoose={onChoose} />
        </div>
      </section>

      <details className="mt-6">
        <summary className="cursor-pointer rounded-md text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
          {t(language, "create.purpose.others.toggle")}
        </summary>
        <div className="mt-3">
          <CardGrid language={language} choices={otherChoices} onChoose={onChoose} />
        </div>
      </details>

      <ul className="mt-8 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{t(language, "create.purpose.guide.draft")}</li>
        <li>{t(language, "create.purpose.guide.firstCheck")}</li>
        <li>{t(language, "create.purpose.guide.nextRun")}</li>
      </ul>
    </div>
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
        <FirstChoice language={language} onChoose={setPurpose} />
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

      {purpose !== null && websiteExample[purpose] ? (
        <RoutineForm
          key={purpose}
          {...formProps}
          mode="website"
          initialTemplateId={websiteExample[purpose]}
        />
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
