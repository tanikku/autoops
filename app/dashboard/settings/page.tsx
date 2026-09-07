import type { Metadata } from "next";
import { CreatorPreferencesForm } from "@/components/creator-preferences-form";
import { DashboardNav } from "@/components/dashboard-nav";
import { LanguageForm } from "@/components/language-form";
import { TimezoneForm } from "@/components/timezone-form";
import { readCreatorProfile } from "@/lib/creator/repository";
import { t } from "@/lib/i18n";
import { getDocumentLanguage } from "@/lib/i18n/server";
import { requireUserId } from "@/lib/session";
import { supportMailtoHref } from "@/lib/support";
import { getUserLanguage, getUserTimezone } from "@/lib/users";

/**
 * The title and description in the language the screen itself is in.
 *
 * **The document already declares a language.** `app/layout.tsx` writes the
 * account's onto `<html>`, and everything visible here follows it — so a title
 * left in English would be the one part of the page contradicting the
 * attribute a screen reader chooses its voice from.
 *
 * **The heading is reused, and it is generic on purpose.** No id is read and
 * no owned record is fetched to build a title: what a browser tab says must
 * not depend on a row this request has not been shown it may see.
 *
 * **Read-only.** `getDocumentLanguage` decodes the session and falls back to
 * English; no account row is read into existence to render a title.
 */
export async function generateMetadata(): Promise<Metadata> {
  const language = await getDocumentLanguage();

  return {
    title: `${t(language, "settings.title")} — Koqentra`,
    description: t(language, "settings.metadataDescription"),
  };
}

// The timezone lives in the database, so this page must not be prerendered.
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const userId = await requireUserId();
  // **Read for the signed-in account, and read-only.** Opening this page must
  // not bring a profile row into being: an account that has never analysed
  // anything gets `EMPTY_CREATOR_PROFILE` back and sees an empty form, which
  // is exactly right. The row is created by the save below it, or by an analysis.
  const [timezone, language, creatorProfile] = await Promise.all([
    getUserTimezone(userId),
    getUserLanguage(userId),
    readCreatorProfile(userId),
  ]);

  // Read after the language, because the subject line is one of the words the
  // account reads. Null whenever no address is configured.
  const supportHref = supportMailtoHref(t(language, "settings.support.subject"));

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {t(language, "settings.title")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(language, "settings.description")}
        </p>

        <TimezoneForm timezone={timezone} language={language} />

        {/* A heading here says which section the control belongs to — the rest
            of the wording lives with the form. */}
        <section className="mt-12 border-t border-border pt-8">
          <h2 className="text-lg font-medium tracking-tight">
            {t(language, "settings.language.title")}
          </h2>

          <LanguageForm language={language} />
        </section>

        {/* **Beside the two account settings rather than on the Creator
            screens**, because this is something stated once about an account
            and then left alone — not part of handing a piece of writing over.
            The panel on `/creator/new` shows the same three values back at the
            moment they are about to be used. */}
        {/* **Named so a link can land on it.** This section is third on the
            page, and the Creator screen sends people here who have never seen
            Settings before — arriving at the timezone and having to hunt is
            how somebody concludes the thing they were sent for is not
            there. */}
        <section
          id="creator-preferences"
          className="mt-12 border-t border-border pt-8"
        >
          <h2 className="text-lg font-medium tracking-tight">
            {t(language, "settings.creator.title")}
          </h2>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            {t(language, "settings.creator.description")}
          </p>

          <CreatorPreferencesForm profile={creatorProfile} language={language} />
        </section>

        {/* **The one page behind sign-in that is about the account rather than
            about a worker**, and the only one with somewhere to put this: no
            dashboard page has a footer. Somebody who is stuck goes looking for
            settings.

            **Absent rather than broken when nothing is configured.** With no
            address set there is no section at all — a reader is never shown a
            link that goes nowhere, nor told that an operator forgot something
            that is not their problem. See `lib/support.ts`. */}
        {supportHref ? (
          <section className="mt-12 border-t border-border pt-8">
            <h2 className="text-lg font-medium tracking-tight">
              {t(language, "settings.support.title")}
            </h2>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              {t(language, "settings.support.description")}
            </p>
            <a
              href={supportHref}
              className="mt-4 inline-block text-sm underline underline-offset-4"
            >
              {t(language, "settings.support.action")}
            </a>
          </section>
        ) : null}
      </main>
    </div>
  );
}
