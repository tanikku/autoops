import type { Metadata } from "next";
import { DashboardNav } from "@/components/dashboard-nav";
import { TimezoneForm } from "@/components/timezone-form";
import { requireUserId } from "@/lib/session";
import { getUserTimezone } from "@/lib/users";

export const metadata: Metadata = {
  title: "Settings — AutoOps",
  description: "Account settings.",
};

// The timezone lives in the database, so this page must not be prerendered.
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const userId = await requireUserId();
  const timezone = await getUserTimezone(userId);

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Settings
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          How AutoOps reads and schedules times for your account.
        </p>

        <TimezoneForm timezone={timezone} />
      </main>
    </div>
  );
}
