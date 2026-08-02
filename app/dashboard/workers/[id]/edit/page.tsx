import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DashboardNav } from "@/components/dashboard-nav";
import { WorkerEditForm } from "@/components/worker-edit-form";
import { getRoutine } from "@/lib/routines";
import { requireUserId } from "@/lib/session";

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
  // exist: both 404, so the id is never confirmed.
  const worker = await getRoutine(id, userId);

  if (!worker) {
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
            name: worker.name,
            description: worker.description,
            prompt: worker.prompt,
            schedule: worker.schedule,
            frequency: worker.frequency,
            status: worker.status,
          }}
        />
      </main>
    </div>
  );
}
