import type { Metadata } from "next";
import { DashboardNav } from "@/components/dashboard-nav";
import { RoutineCard } from "@/components/routine-card";
import { Button } from "@/components/ui/button";
import { mockRoutines } from "@/lib/mock-data";

export const metadata: Metadata = {
  title: "Dashboard — AutoOps",
  description: "Manage your AI routines.",
};

export default function DashboardPage() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Welcome back 👋
          </h1>
          <Button className="w-full sm:w-auto">+ New Routine</Button>
        </div>

        <section className="mt-10">
          <h2 className="text-lg font-medium tracking-tight">My Routines</h2>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {mockRoutines.map((routine) => (
              <RoutineCard key={routine.id} routine={routine} />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
