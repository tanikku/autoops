import type { Metadata } from "next";
import { DashboardNav } from "@/components/dashboard-nav";
import { RoutineForm } from "@/components/routine-form";

export const metadata: Metadata = {
  title: "Hire Worker — AutoOps",
  description: "Add a new AI worker to your team.",
};

export default function NewRoutinePage() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Hire Worker
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Define the worker once. AutoOps runs it on your schedule.
        </p>

        <RoutineForm />
      </main>
    </div>
  );
}
