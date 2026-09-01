import { describe, expect, it } from "vitest";
import {
  hasWorkerFormErrors,
  readWorkerForm,
  summarizeWorkerFormErrors,
  validateWorkerFormForKind,
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
    emailNotificationsEnabled: false,
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
 * What a kind is read as, and what it is not read for.
 *
 * A kind that cannot be recognised reads as null rather than as `prompt`: a
 * reader that guessed would decide, on behalf of the boundary, what a
 * submission was asking for.
 *
 * **The address is read as submitted, whatever the kind says.** It is not the
 * reader's to drop — editing takes the kind from the stored worker, so a reader
 * that gated on the submitted one would gate on the very field that boundary
 * distrusts. Who ignores an address, and when, is asserted where the kind is
 * actually known: the two action suites.
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
  ])("keeps the address as submitted on %s", (_label, fields) => {
    const parsed = readWorkerForm(
      form({ ...fields, websiteUrl: "https://example.com/news" }),
    );

    expect(parsed.websiteUrl).toBe("https://example.com/news");
  });

  it("reads a missing address as blank", () => {
    expect(readWorkerForm(form({ kind: "website" })).websiteUrl).toBe("");
  });

  /**
   * The length limit belongs to the field, and the field belongs to one kind.
   * A prompt worker rejected for an address it was never shown would be a
   * complaint about a box that is not on its form.
   */
  it("does not hold a prompt worker to the address limit", () => {
    const parsed = readWorkerForm(
      form({
        kind: "prompt",
        websiteUrl: "a".repeat(workerFieldLimits.websiteUrl + 1),
      }),
    );

    expect(
      validateWorkerFormForKind(parsed, context(), "prompt").websiteUrl,
    ).toBeUndefined();
  });
});

/**
 * The one setting that reaches outside AutoOps, as a form carries it.
 *
 * **A checkbox submits nothing when it is not ticked**, so "absent" has to mean
 * off — and it has to mean off identically on both forms, because an edit that
 * read an omitted field as "leave it alone" would make turning notifications
 * back off impossible.
 *
 * **What is read is whether to send and never where.** There is no address in
 * `WorkerFormInput` and nothing here puts one there: the recipient is looked up
 * from the worker's owner when a run finishes.
 */
describe("readWorkerForm — email notifications", () => {
  function form(fields: Record<string, string> = {}) {
    const data = new FormData();
    data.set("name", "Daily digest");
    for (const [key, value] of Object.entries(fields)) {
      data.set(key, value);
    }
    return data;
  }

  it("is off when the form does not mention it", () => {
    expect(readWorkerForm(form()).emailNotificationsEnabled).toBe(false);
  });

  it.each(["on", "true", "1", "TRUE"])("is on when the value is %s", (value) => {
    expect(
      readWorkerForm(form({ emailNotificationsEnabled: value }))
        .emailNotificationsEnabled,
    ).toBe(true);
  });

  it.each([
    ["blank", ""],
    ["off", "off"],
    ["false", "false"],
    ["something nobody chose", "yes-please"],
  ])("is off when the value is %s", (_label, value) => {
    expect(
      readWorkerForm(form({ emailNotificationsEnabled: value }))
        .emailNotificationsEnabled,
    ).toBe(false);
  });

  it("takes no recipient from the submission, whatever it carries", () => {
    const parsed = readWorkerForm(
      form({
        emailNotificationsEnabled: "on",
        email: "attacker@example.test",
        to: "attacker@example.test",
        notificationEmail: "attacker@example.test",
        recipient: "attacker@example.test",
      }),
    );

    expect(parsed.emailNotificationsEnabled).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("attacker@example.test");
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
describe("validateWorkerFormForKind — website workers", () => {
  function website(overrides?: Partial<WorkerFormInput>): WorkerFormInput {
    return input({
      kind: "website",
      websiteUrl: "https://example.com/news",
      prompt: "Tell me what changed.",
      ...overrides,
    });
  }

  it("accepts a complete website worker", () => {
    expect(validateWorkerFormForKind(website(), context(), "website")).toEqual({});
  });

  it("requires an address", () => {
    const errors = validateWorkerFormForKind(
      website({ websiteUrl: "" }),
      context(),
      "website",
    );

    expect(errors.websiteUrl).toBeDefined();
  });

  it("rejects an address longer than the limit", () => {
    const long = `https://example.com/${"a".repeat(workerFieldLimits.websiteUrl)}`;

    expect(
      validateWorkerFormForKind(
        website({ websiteUrl: long }),
        context(),
        "website",
      ).websiteUrl,
    ).toBeDefined();
  });

  it("accepts an address exactly at the limit", () => {
    const exact = `https://example.com/${"a".repeat(
      workerFieldLimits.websiteUrl - "https://example.com/".length,
    )}`;

    expect(exact).toHaveLength(workerFieldLimits.websiteUrl);
    expect(
      validateWorkerFormForKind(
        website({ websiteUrl: exact }),
        context(),
        "website",
      ).websiteUrl,
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
      const errors = validateWorkerFormForKind(
        website({ prompt: "" }),
        context({ status, frequency }),
        "website",
      );

      expect(errors.prompt).toBeDefined();
    },
  );

  it("rejects instructions longer than the prompt limit", () => {
    const errors = validateWorkerFormForKind(
      website({ prompt: "a".repeat(workerFieldLimits.prompt + 1) }),
      context(),
      "website",
    );

    expect(errors.prompt).toBeDefined();
  });

  it("accepts instructions exactly at the prompt limit", () => {
    const errors = validateWorkerFormForKind(
      website({ prompt: "a".repeat(workerFieldLimits.prompt) }),
      context(),
      "website",
    );

    expect(errors.prompt).toBeUndefined();
  });

  it("still requires a name", () => {
    expect(
      validateWorkerFormForKind(website({ name: "" }), context(), "website")
        .name,
    ).toBeDefined();
  });
});

/** A prompt worker is validated exactly as it was before kinds existed. */
describe("validateWorkerFormForKind — prompt workers", () => {
  it.each([
    ["draft", "daily"],
    ["paused", "monthly"],
    ["active", "manual"],
  ] as const)("keeps its blank prompt on a %s %s worker", (status, frequency) => {
    const errors = validateWorkerFormForKind(
      input({ kind: "prompt", prompt: "" }),
      context({ status, frequency }),
      "prompt",
    );

    expect(errors).toEqual({});
  });

  it("still refuses a blank prompt when Koqentra would run it unattended", () => {
    const errors = validateWorkerFormForKind(
      input({ kind: "prompt", prompt: "" }),
      context({ status: "active", frequency: "daily" }),
      "prompt",
    );

    expect(errors.prompt).toBe(
      "Prompt is required for scheduled active workers.",
    );
  });

  it("never asks a prompt worker for an address", () => {
    const errors = validateWorkerFormForKind(
      input({ kind: "prompt", prompt: "Summarise this." }),
      context({ status: "active", frequency: "daily" }),
      "prompt",
    );

    expect(errors.websiteUrl).toBeUndefined();
  });
});

/**
 * The same rules, refused in Japanese.
 *
 * **What is checked does not move.** Which fields are required, when a blank
 * prompt is allowed, and where each limit sits are the same questions in both
 * languages — these tests fix that the answers differ only in wording, and
 * that a Japanese refusal never names a field in English.
 */
describe("in Japanese", () => {
  const blank = {
    name: "",
    description: "",
    prompt: "",
    websiteUrl: "",
    kind: null,
    status: null,
    frequency: null,
    runAtMinutes: null,
    runAtWeekday: null,
    runAtDay: null,
    emailNotificationsEnabled: false,
  };

  const draft = { status: "draft" as const, frequency: "manual" as const };
  const scheduled = { status: "active" as const, frequency: "daily" as const };

  it("says a name is required", () => {
    const errors = validateWorkerForm(blank, draft, "ja");

    expect(errors.name).toBe("名前は必須です。");
  });

  it("says a scheduled active worker needs a prompt", () => {
    const errors = validateWorkerForm(
      { ...blank, name: "Watcher" },
      scheduled,
      "ja",
    );

    expect(errors.prompt).toBe(
      "稼働中で定期実行する Worker にはプロンプトが必要です。",
    );
  });

  /** A Japanese message must not name the field in English. */
  it("names the field in Japanese when something is too long", () => {
    const errors = validateWorkerForm(
      { ...blank, name: "a".repeat(workerFieldLimits.name + 1) },
      draft,
      "ja",
    );

    expect(errors.name).toBe("名前は100文字以内で入力してください。");
    expect(errors.name).not.toContain("Name");
  });

  it("says a website worker needs an address", () => {
    const errors = validateWorkerFormForKind(
      { ...blank, name: "Watcher", prompt: "Tell me." },
      draft,
      "website",
      "ja",
    );

    expect(errors.websiteUrl).toBe("Web ページのアドレスは必須です。");
  });

  it("says a website worker needs change instructions", () => {
    const errors = validateWorkerFormForKind(
      { ...blank, name: "Watcher", websiteUrl: "https://example.com" },
      draft,
      "website",
      "ja",
    );

    expect(errors.prompt).toBe(
      "ページが変わったときに何をするかを入力してください。",
    );
  });

  it("counts the fields that need attention", () => {
    const errors = validateWorkerFormForKind(blank, draft, "website", "ja");

    expect(Object.keys(errors).length).toBeGreaterThan(1);
    expect(summarizeWorkerFormErrors(errors, "ja")).toBe(
      `${Object.keys(errors).length} 件の入力を確認してください。`,
    );
  });

  it("hands a single message straight through, in either language", () => {
    const errors = validateWorkerForm(blank, draft, "ja");

    expect(summarizeWorkerFormErrors(errors, "ja")).toBe("名前は必須です。");
  });
});

/**
 * What a language does not decide.
 *
 * The rules are the contract; the words are not. Every case below asks the
 * same question in both languages and expects the same answer about *which*
 * fields are wrong — only the sentences differ.
 */
describe("what the language does not change", () => {
  const base = {
    name: "",
    description: "",
    prompt: "",
    websiteUrl: "",
    kind: null,
    status: null,
    frequency: null,
    runAtMinutes: null,
    runAtWeekday: null,
    runAtDay: null,
    emailNotificationsEnabled: false,
  };

  it.each([
    ["a blank draft", base, { status: "draft" as const, frequency: "manual" as const }],
    [
      "a scheduled active worker",
      { ...base, name: "Watcher" },
      { status: "active" as const, frequency: "daily" as const },
    ],
    [
      "an over-long prompt",
      { ...base, name: "Watcher", prompt: "a".repeat(workerFieldLimits.prompt + 1) },
      { status: "draft" as const, frequency: "manual" as const },
    ],
  ])("rejects the same fields for %s", (_label, input, context) => {
    const english = validateWorkerForm(input, context, "en");
    const japanese = validateWorkerForm(input, context, "ja");

    expect(Object.keys(japanese).sort()).toEqual(Object.keys(english).sort());
  });

  it("falls back to English for a language it does not know", () => {
    expect(validateWorkerForm(base, { status: "draft", frequency: "manual" }, "fr").name)
      .toBe("Name is required.");
  });

  /** Callers that have not been given a language yet keep what they had. */
  it("still answers in English when none is given", () => {
    expect(validateWorkerForm(base, { status: "draft", frequency: "manual" }).name)
      .toBe("Name is required.");
  });
});
