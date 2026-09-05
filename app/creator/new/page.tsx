import type { Metadata } from "next";
import { CreatorAnalysisForm } from "@/components/creator-analysis-form";
import { DashboardNav } from "@/components/dashboard-nav";
import { t } from "@/lib/i18n";
import { requireUserId } from "@/lib/session";
import { getUserLanguage } from "@/lib/users";

export const metadata: Metadata = {
  title: "Analyze content — Koqentra",
  description: "Have Koqentra read a piece of writing and say where it belongs.",
};

// The wording comes from the account row, so this page must not be prerendered.
export const dynamic = "force-dynamic";

/**
 * Where a piece of writing is handed over.
 *
 * **The description says that a skip is a real answer.** Somebody arriving here
 * expecting three posts out of every article would read a `skip` as a failure;
 * saying so first is the difference between an editor and a generator.
 *
 * `requireUserId` rather than the provisioning boundary: rendering a form
 * writes nothing, and the row is brought into being by the action once there is
 * something worth analysing.
 */
export default async function CreatorNewPage() {
  const userId = await requireUserId();
  const language = await getUserLanguage(userId);

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {t(language, "creator.new.title")}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {t(language, "creator.new.description")}
        </p>

        <CreatorAnalysisForm language={language} />
      </main>
    </div>
  );
}
