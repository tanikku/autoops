import {
  isRoutineFrequency,
  isRoutineStatus,
  type RoutineFrequency,
  type RoutineStatus,
} from "@/types";

/**
 * Upper bounds for the free-text fields.
 *
 * Each is set by what the field has to survive downstream rather than by what
 * the column can hold — SQLite would take far more:
 *
 * - `name` appears in cards, toasts and page titles, so it has to stay
 *   readable when truncated.
 * - `description` is a sentence or two under the name; longer belongs in the
 *   prompt.
 * - `prompt` is sent to the model on every run, so its length is a cost and
 *   latency ceiling as much as a storage one. 10,000 characters is roughly
 *   2,500–5,000 tokens: ample for instructions, far short of a context limit.
 */
export const workerFieldLimits = {
  name: 100,
  description: 500,
  prompt: 10_000,
} as const;

export type WorkerFieldName = keyof typeof workerFieldLimits;

/** Field-level messages, keyed by field. Empty means the input is acceptable. */
export type WorkerFieldErrors = Partial<Record<WorkerFieldName, string>>;

const fieldLabels: Record<WorkerFieldName, string> = {
  name: "Name",
  description: "Description",
  prompt: "Prompt",
};

export type WorkerFormInput = {
  name: string;
  description: string;
  prompt: string;
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
    status: isRoutineStatus(status) ? status : null,
    frequency: isRoutineFrequency(frequency) ? frequency : null,
  };
}

/**
 * The single source of truth for what a valid worker looks like.
 *
 * Both actions call this and neither adds checks of its own, so a rule cannot
 * apply on creation and go missing on edit.
 *
 * Only the name is required. Description and Prompt may be blank — a worker
 * without either is still a valid record.
 */
export function validateWorkerForm(input: WorkerFormInput): WorkerFieldErrors {
  const errors: WorkerFieldErrors = {};

  if (!input.name) {
    errors.name = "Name is required.";
  }

  for (const field of Object.keys(workerFieldLimits) as WorkerFieldName[]) {
    // A field already rejected keeps its first message: "Name is required"
    // says more than a length complaint about an empty string ever could.
    if (errors[field]) {
      continue;
    }

    const limit = workerFieldLimits[field];
    if (input[field].length > limit) {
      errors[field] =
        `${fieldLabels[field]} must be ${limit.toLocaleString("en-US")} characters or fewer.`;
    }
  }

  return errors;
}

export function hasWorkerFormErrors(errors: WorkerFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * One line for the toast, which has room for a sentence rather than a list.
 *
 * The fields keep the detail; this only has to say that something is wrong.
 */
export function summarizeWorkerFormErrors(errors: WorkerFieldErrors): string {
  const messages = Object.values(errors);

  return messages.length === 1
    ? messages[0]
    : `${messages.length} fields need attention.`;
}
