import type { Metadata } from "next";
import { DashboardNav } from "@/components/dashboard-nav";
import { RoutineForm } from "@/components/routine-form";
import { t } from "@/lib/i18n";
import { requireUserId } from "@/lib/session";
import { getUserLanguage, getUserTimezone } from "@/lib/users";

export const metadata: Metadata = {
  title: "Hire Worker — AutoOps",
  description: "Add a new AI worker to your team.",
};

// The zone comes from the account row, so this page must not be prerendered.
export const dynamic = "force-dynamic";

export default async function NewRoutinePage() {
  // Read, never written: this only decides what the form says about the
  // schedule it is about to create. The action reads the same value again when
  // it works out the first slot.
  const userId = await requireUserId();
  const [timezone, language] = await Promise.all([
    getUserTimezone(userId),
    getUserLanguage(userId),
  ]);

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-10">
        {/* The dashboard's button and this heading are the same act under
            the same words, so they share a key rather than drifting apart. */}
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {t(language, "dashboard.hireWorker")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(language, "worker.create.description")}
        </p>

        <RoutineForm timezone={timezone} language={language} />
      </main>
    </div>
  );
}
