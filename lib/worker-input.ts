import {
  isRoutineFrequency,
  isRoutineStatus,
  type RoutineFrequency,
  type RoutineStatus,
} from "@/types";

export type WorkerFormInput = {
  name: string;
  description: string;
  prompt: string;
  schedule: string;
  /** null when the field is absent or holds a value the app does not accept. */
  status: RoutineStatus | null;
  frequency: RoutineFrequency | null;
};

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

/**
 * Reads a worker out of submitted form data.
 *
 * Shared by the hire and edit actions so the two cannot drift: the fields
 * read, the trimming, and the treatment of an unrecognised status or frequency
 * are decided once. Callers supply their own fallback for the two nullable
 * fields, because "new worker" and "existing worker" default differently.
 */
export function readWorkerForm(formData: FormData): WorkerFormInput {
  const status = text(formData, "status");
  const frequency = text(formData, "frequency");

  return {
    name: text(formData, "name"),
    description: text(formData, "description"),
    prompt: text(formData, "prompt"),
    schedule: text(formData, "schedule"),
    status: isRoutineStatus(status) ? status : null,
    frequency: isRoutineFrequency(frequency) ? frequency : null,
  };
}

/**
 * Returns the message to show, or null when the input is acceptable.
 *
 * Only the name is required. Description and Schedule are free text and may be
 * blank — a worker without either is still runnable.
 */
export function validateWorkerForm(input: WorkerFormInput): string | null {
  if (!input.name) {
    return "Name is required.";
  }

  return null;
}
