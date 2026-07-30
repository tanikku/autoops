import type { Metadata } from "next";
import Link from "next/link";
import { DashboardNav } from "@/components/dashboard-nav";
import { RoutineCard } from "@/components/routine-card";
import { RunHistoryList } from "@/components/run-history-list";
import { Button } from "@/components/ui/button";
import { listRoutines } from "@/lib/routines";
import { listRunHistory } from "@/lib/runs";

export const metadata: Metadata = {
  title: "Dashboard — AutoOps",
  description: "Manage and monitor your AI workers.",
};

// Routines live in the database, so this page must not be prerendered.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [routines, runs] = await Promise.all([
    listRoutines(),
    listRunHistory(),
  ]);

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              My AI Team
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage and monitor your AI workers.
            </p>
          </div>
          <Button
            className="w-full sm:w-auto"
            nativeButton={false}
            render={<Link href="/dashboard/new" />}
          >
            Hire Worker
          </Button>
        </div>

        <section className="mt-10">
          <h2 className="text-lg font-medium tracking-tight">My Workers</h2>

          {routines.length === 0 ? (
            <div className="mt-4 flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">No workers yet.</p>
              <Button
                nativeButton={false}
                render={<Link href="/dashboard/new" />}
              >
                Hire your first Worker
              </Button>
            </div>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {routines.map((routine) => (
                <RoutineCard key={routine.id} routine={routine} />
              ))}
            </div>
          )}
        </section>

        <section className="mt-10">
          <h2 className="text-lg font-medium tracking-tight">Activity</h2>
          <RunHistoryList runs={runs} />
        </section>
      </main>
    </div>
  );
}
