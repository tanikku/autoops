import type { Metadata } from "next";
import { DashboardNav } from "@/components/dashboard-nav";
import { LanguageForm } from "@/components/language-form";
import { TimezoneForm } from "@/components/timezone-form";
import { t } from "@/lib/i18n";
import { requireUserId } from "@/lib/session";
import { getUserLanguage, getUserTimezone } from "@/lib/users";

export const metadata: Metadata = {
  title: "Settings — Koqentra",
  description: "Account settings.",
};

// The timezone lives in the database, so this page must not be prerendered.
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const userId = await requireUserId();
  const [timezone, language] = await Promise.all([
    getUserTimezone(userId),
    getUserLanguage(userId),
  ]);

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
      </main>
    </div>
  );
}
