import { describe, expect, it } from "vitest";
import {
  hasWorkerFormErrors,
  readWorkerForm,
  summarizeWorkerFormErrors,
  validateWorkerForm,
  workerFieldLimits,
  type WorkerFormContext,
  type WorkerFormInput,
} from "@/lib/worker-input";

/**
 * What a worker has to have, and when.
 *
 * The rule worth pinning down is the one that depends on two other fields: a
 * blank prompt is fine until AutoOps is the one running the worker. Everything
 * around it — draft, paused, manual — keeps the blank, because the failure
 * being prevented is the unattended kind that repeats, not the one someone
 * asked for and is watching.
 */

function input(overrides?: Partial<WorkerFormInput>): WorkerFormInput {
  return {
    name: "Daily digest",
    description: "",
    prompt: "",
    status: null,
    frequency: null,
    runAtMinutes: null,
    runAtWeekday: null,
    runAtDay: null,
    ...overrides,
  };
}

function context(overrides?: Partial<WorkerFormContext>): WorkerFormContext {
  return { status: "draft", frequency: "manual", ...overrides };
}

const scheduled = ["daily", "weekly", "monthly"] as const;

describe("validateWorkerForm — a blank prompt", () => {
  it("is allowed on a draft", () => {
    const errors = validateWorkerForm(input(), context({ status: "draft" }));

    expect(errors).toEqual({});
  });

  /**
   * Paused says "Scheduled runs are paused. Manual runs still work." — nothing
   * dispatches it, so there is no unattended run to protect.
   */
  it("is allowed on a paused worker", () => {
    const errors = validateWorkerForm(
      input(),
      context({ status: "paused", frequency: "daily" }),
    );

    expect(errors).toEqual({});
  });

  /**
   * An active worker with no cadence has no slot to be dispatched into — its
   * `nextRunAt` is null and the scheduler never selects it. Rejecting it would
   * forbid a state that cannot fail unattended.
   */
  it("is allowed on an active worker with manual frequency", () => {
    const errors = validateWorkerForm(
      input(),
      context({ status: "active", frequency: "manual" }),
    );

    expect(errors).toEqual({});
  });

  it.each(scheduled)("is rejected on an active %s worker", (frequency) => {
    const errors = validateWorkerForm(
      input(),
      context({ status: "active", frequency }),
    );

    expect(errors.prompt).toBe(
      "Prompt is required for scheduled active workers.",
    );
  });

  it("is accepted once the prompt has something in it", () => {
    const errors = validateWorkerForm(
      input({ prompt: "Summarise today's news." }),
      context({ status: "active", frequency: "daily" }),
    );

    expect(errors).toEqual({});
  });
});

/**
 * The saved values, not the submitted ones. A form that leaves the status out
 * still lands on whatever the worker already was, and asking about the absent
 * field would let exactly that through.
 */
describe("validateWorkerForm — the values it asks about", () => {
  it("rejects a blank prompt when the status was absent and falls back to active", () => {
    const errors = validateWorkerForm(
      input({ status: null, frequency: null }),
      context({ status: "active", frequency: "daily" }),
    );

    expect(errors.prompt).toBeDefined();
  });

  it("rejects a blank prompt when the frequency was absent and falls back to a cadence", () => {
    const errors = validateWorkerForm(
      input({ status: "active", frequency: null }),
      context({ status: "active", frequency: "weekly" }),
    );

    expect(errors.prompt).toBeDefined();
  });

  it("allows a blank prompt when the fallbacks land on draft and manual", () => {
    const errors = validateWorkerForm(
      input({ status: null, frequency: null }),
      context({ status: "draft", frequency: "manual" }),
    );

    expect(errors).toEqual({});
  });
});

/**
 * Blankness is decided after trimming, and the trimming happens in
 * `readWorkerForm`. Going through it is the only way to check that a prompt of
 * spaces counts as absent rather than as content.
 */
describe("readWorkerForm — whitespace", () => {
  function form(prompt: string) {
    const data = new FormData();
    data.set("name", "Daily digest");
    data.set("prompt", prompt);
    return data;
  }

  it.each([
    ["spaces", "   "],
    ["a newline", "\n"],
    ["a tab", "\t"],
    ["a mix", " \n\t "],
  ])("reads a prompt of %s as blank", (_label, value) => {
    expect(readWorkerForm(form(value)).prompt).toBe("");
  });

  it("keeps a prompt that has content, without its surrounding space", () => {
    expect(readWorkerForm(form("  do the thing  ")).prompt).toBe(
      "do the thing",
    );
  });

  it("rejects a whitespace-only prompt on an active scheduled worker", () => {
    const parsed = readWorkerForm(form("   "));

    const errors = validateWorkerForm(
      parsed,
      context({ status: "active", frequency: "daily" }),
    );

    expect(errors.prompt).toBeDefined();
  });
});

/** The rules that were here before, unchanged by the one that arrived. */
describe("validateWorkerForm — the existing rules", () => {
  it("requires a name", () => {
    expect(validateWorkerForm(input({ name: "" }), context()).name).toBe(
      "Name is required.",
    );
  });

  it("treats a whitespace-only name as missing", () => {
    const data = new FormData();
    data.set("name", "   ");

    expect(validateWorkerForm(readWorkerForm(data), context()).name).toBe(
      "Name is required.",
    );
  });

  it.each(["name", "description", "prompt"] as const)(
    "accepts %s at its limit",
    (field) => {
      const value = "x".repeat(workerFieldLimits[field]);

      expect(validateWorkerForm(input({ [field]: value }), context())).toEqual(
        {},
      );
    },
  );

  it.each(["name", "description", "prompt"] as const)(
    "rejects %s one character past its limit",
    (field) => {
      const value = "x".repeat(workerFieldLimits[field] + 1);

      expect(
        validateWorkerForm(input({ [field]: value }), context())[field],
      ).toContain("or fewer");
    },
  );

  /** "Name is required" says more than a length complaint about "". */
  it("keeps the first message a field earned", () => {
    const errors = validateWorkerForm(input({ name: "" }), context());

    expect(errors.name).toBe("Name is required.");
  });
});

describe("summarizeWorkerFormErrors", () => {
  it("passes a single message through", () => {
    const errors = validateWorkerForm(input({ name: "" }), context());

    expect(summarizeWorkerFormErrors(errors)).toBe("Name is required.");
  });

  it("counts them once there is more than one", () => {
    const errors = validateWorkerForm(
      input({ name: "" }),
      context({ status: "active", frequency: "daily" }),
    );

    expect(hasWorkerFormErrors(errors)).toBe(true);
    expect(summarizeWorkerFormErrors(errors)).toBe(
      "2 fields need attention.",
    );
  });

  it("reports nothing to fix on acceptable input", () => {
    expect(hasWorkerFormErrors(validateWorkerForm(input(), context()))).toBe(
      false,
    );
  });
});
