"use client";

import { useState } from "react";
import { RoutineForm } from "@/components/routine-form";
import { TemplateWatchForm } from "@/components/template-watch-form";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { t, type TranslationKey } from "@/lib/i18n";
import type { EmailEntitlement } from "@/lib/plans";

/**
 * Hiring a worker, starting from what the person is waiting for.
 *
 * **Two purposes have a form of their own; the rest are the forms that were
 * already here.** A hotel vacancy and a restock are answered in a few fields
 * and compiled on the server. "Other page changes" is the website form on its
 * own, and "Build your own" is the whole previous screen — the draft, the
 * kinds, the examples — unchanged, under one card.
 */

export type CreationPurpose = "hotel" | "restock" | "website" | "free";

const purposes: {
  value: CreationPurpose;
  title: TranslationKey;
  description: TranslationKey;
}[] = [
  {
    value: "hotel",
    title: "create.purpose.hotel.title",
    description: "create.purpose.hotel.description",
  },
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
    value: "free",
    title: "create.purpose.free.title",
    description: "create.purpose.free.description",
  },
];

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
  /** Which purpose is open first. Null shows the choice. */
  initialPurpose?: CreationPurpose | null;
}) {
  const [purpose, setPurpose] = useState<CreationPurpose | null>(initialPurpose);
  const template = purpose === "hotel" || purpose === "restock";

  return (
    <>
      {trialNote && !template ? (
        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
          <p className="text-sm text-muted-foreground">{trialNote}</p>
        </div>
      ) : null}

      {purpose === null ? (
        <section className="mt-8 max-w-2xl">
          <h2 className="text-lg font-medium tracking-tight">
            {t(language, "create.purpose.heading")}
          </h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {purposes.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setPurpose(item.value)}
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
      ) : (
        <div className="mt-6">
          <Button type="button" variant="ghost" size="sm" onClick={() => setPurpose(null)}>
            {t(language, "create.purpose.back")}
          </Button>
        </div>
      )}

      {purpose === "hotel" || purpose === "restock" ? (
        <TemplateWatchForm
          templateId={purpose === "hotel" ? "hotel-availability" : "product-restock"}
          timezone={timezone}
          language={language}
          emailEntitlement={emailEntitlement}
          trialNote={trialNote}
        />
      ) : null}

      {purpose === "website" || purpose === "free" ? (
        <RoutineForm
          timezone={timezone}
          language={language}
          emailEntitlement={emailEntitlement}
          mode={purpose}
        />
      ) : null}
    </>
  );
}
