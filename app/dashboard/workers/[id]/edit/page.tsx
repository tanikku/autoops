import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DashboardNav } from "@/components/dashboard-nav";
import { WorkerEditForm } from "@/components/worker-edit-form";
import { getRoutineForEdit } from "@/lib/routines";
import { requireUserId } from "@/lib/session";
import { getUserTimezone } from "@/lib/users";
import { getWebsiteSource } from "@/lib/website-sources";
import { minutesToTimeValue } from "@/lib/worker-input";

export const metadata: Metadata = {
  title: "Edit Worker — AutoOps",
  description: "Update an AI worker.",
};

// Workers live in the database, so this page must not be prerendered.
export const dynamic = "force-dynamic";

export default async function EditWorkerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await requireUserId();
  // A worker owned by someone else is indistinguishable from one that does not
  // exist: both 404, so the id is never confirmed. So is one stored with a kind
  // this version cannot read — offering a form for a worker nobody can describe
  // would end in saving an answer that was never given.
  const worker = await getRoutineForEdit(id, userId);

  if (!worker) {
    notFound();
  }

  // What the form says about the schedule it is editing. Read only.
  const timezone = await getUserTimezone(userId);

  // **Only a website worker has a page, and only it is asked for one.**
  const source =
    worker.kind === "website" ? await getWebsiteSource(id, userId) : null;

  // A website worker with nothing to watch is a state that should not exist.
  // Rendering it as a prompt worker would hide that, and saving the form would
  // then be a conversion nobody asked for — so it is treated as no worker.
  if (worker.kind === "website" && !source) {
    notFound();
  }

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Edit Worker
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Changes apply to the next run.
        </p>

        <WorkerEditForm
          worker={{
            id: worker.id,
            kind: worker.kind,
            name: worker.name,
            description: worker.description,
            prompt: worker.prompt,
            websiteUrl: source?.url,
            frequency: worker.frequency,
            status: worker.status,
            runAt: minutesToTimeValue(worker.runAtMinutes),
            runAtWeekday: worker.runAtWeekday,
            runAtDay: worker.runAtDay,
          }}
          timezone={timezone}
        />
      </main>
    </div>
  );
}
