import { describe, expect, it } from "vitest";
import {
  hasWorkerFormErrors,
  readWorkerForm,
  summarizeWorkerFormErrors,
  validateCreateWorkerForm,
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
    websiteUrl: "",
    kind: null,
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

/**
 * What a kind changes, and what it must not.
 *
 * The address is the obvious part. The part worth pinning down is the drop: a
 * URL that arrives on a submission which is not creating a website worker has
 * to disappear before anything downstream can act on it, because the thing
 * downstream would do is give a prompt worker a page to watch.
 */
describe("readWorkerForm — kind", () => {
  function form(fields: Record<string, string>) {
    const data = new FormData();
    data.set("name", "Daily digest");
    for (const [key, value] of Object.entries(fields)) {
      data.set(key, value);
    }
    return data;
  }

  it.each(["prompt", "website"] as const)("reads %s", (kind) => {
    expect(readWorkerForm(form({ kind })).kind).toBe(kind);
  });

  it.each([
    ["absent", {}],
    ["blank", { kind: "" }],
    ["a value the app does not know", { kind: "webhook" }],
    ["nearly right", { kind: "Website" }],
  ])("reads a kind that is %s as null", (_label, fields) => {
    expect(readWorkerForm(form(fields)).kind).toBeNull();
  });

  it("keeps the address on a website submission", () => {
    const parsed = readWorkerForm(
      form({ kind: "website", websiteUrl: "  https://example.com/news  " }),
    );

    expect(parsed.websiteUrl).toBe("https://example.com/news");
  });

  it.each([
    ["a prompt worker", { kind: "prompt" }],
    ["a submission with no kind", {}],
    ["a submission with an unreadable kind", { kind: "webhook" }],
  ])("drops the address on %s", (_label, fields) => {
    const parsed = readWorkerForm(
      form({ ...fields, websiteUrl: "https://example.com/news" }),
    );

    expect(parsed.websiteUrl).toBe("");
  });
});

/**
 * The rules that only exist because a worker can watch a page.
 *
 * Two things are being held apart here. A website worker is asked for more than
 * a prompt worker is — an address, and instructions whatever its status. And a
 * prompt worker is asked for exactly what it always was, because the shared
 * validator is still the one deciding: nothing here loosens a rule, and the
 * edit form, which never sends a kind, cannot reach any of it.
 */
describe("validateCreateWorkerForm — website workers", () => {
  function website(overrides?: Partial<WorkerFormInput>): WorkerFormInput {
    return input({
      kind: "website",
      websiteUrl: "https://example.com/news",
      prompt: "Tell me what changed.",
      ...overrides,
    });
  }

  it("accepts a complete website worker", () => {
    expect(validateCreateWorkerForm(website(), context())).toEqual({});
  });

  it("requires an address", () => {
    const errors = validateCreateWorkerForm(
      website({ websiteUrl: "" }),
      context(),
    );

    expect(errors.websiteUrl).toBeDefined();
  });

  it("rejects an address longer than the limit", () => {
    const long = `https://example.com/${"a".repeat(workerFieldLimits.websiteUrl)}`;

    expect(
      validateCreateWorkerForm(website({ websiteUrl: long }), context())
        .websiteUrl,
    ).toBeDefined();
  });

  it("accepts an address exactly at the limit", () => {
    const exact = `https://example.com/${"a".repeat(
      workerFieldLimits.websiteUrl - "https://example.com/".length,
    )}`;

    expect(exact).toHaveLength(workerFieldLimits.websiteUrl);
    expect(
      validateCreateWorkerForm(website({ websiteUrl: exact }), context())
        .websiteUrl,
    ).toBeUndefined();
  });

  /**
   * The rule that differs from a prompt worker's. A watcher with no
   * instructions still fetches, still stores a baseline, and still notices a
   * change — and then has nothing to do about it.
   */
  it.each([
    ["draft", "manual"],
    ["draft", "daily"],
    ["paused", "weekly"],
    ["active", "manual"],
    ["active", "daily"],
  ] as const)(
    "requires instructions on a %s worker running %s",
    (status, frequency) => {
      const errors = validateCreateWorkerForm(
        website({ prompt: "" }),
        context({ status, frequency }),
      );

      expect(errors.prompt).toBeDefined();
    },
  );

  it("rejects instructions longer than the prompt limit", () => {
    const errors = validateCreateWorkerForm(
      website({ prompt: "a".repeat(workerFieldLimits.prompt + 1) }),
      context(),
    );

    expect(errors.prompt).toBeDefined();
  });

  it("accepts instructions exactly at the prompt limit", () => {
    const errors = validateCreateWorkerForm(
      website({ prompt: "a".repeat(workerFieldLimits.prompt) }),
      context(),
    );

    expect(errors.prompt).toBeUndefined();
  });

  it("still requires a name", () => {
    expect(
      validateCreateWorkerForm(website({ name: "" }), context()).name,
    ).toBeDefined();
  });
});

/** A prompt worker is validated exactly as it was before kinds existed. */
describe("validateCreateWorkerForm — prompt workers", () => {
  it.each([
    ["draft", "daily"],
    ["paused", "monthly"],
    ["active", "manual"],
  ] as const)("keeps its blank prompt on a %s %s worker", (status, frequency) => {
    const errors = validateCreateWorkerForm(
      input({ kind: "prompt", prompt: "" }),
      context({ status, frequency }),
    );

    expect(errors).toEqual({});
  });

  it("still refuses a blank prompt when AutoOps would run it unattended", () => {
    const errors = validateCreateWorkerForm(
      input({ kind: "prompt", prompt: "" }),
      context({ status: "active", frequency: "daily" }),
    );

    expect(errors.prompt).toBe(
      "Prompt is required for scheduled active workers.",
    );
  });

  it("never asks a prompt worker for an address", () => {
    const errors = validateCreateWorkerForm(
      input({ kind: "prompt", prompt: "Summarise this." }),
      context({ status: "active", frequency: "daily" }),
    );

    expect(errors.websiteUrl).toBeUndefined();
  });
});
