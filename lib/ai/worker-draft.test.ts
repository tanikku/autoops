import { describe, expect, it } from "vitest";
import {
  extractUrlCandidates,
  isInvalidWorkerDraftResponse,
  readWorkerDraftToolResult,
  workerDraftToolNames,
} from "@/lib/ai/worker-draft";
import { workerFieldLimits } from "@/lib/worker-input";

/**
 * What a model is allowed to have decided.
 *
 * Everything here runs on values typed `unknown`, because that is how a tool's
 * input arrives: the schema sent with the request is an instruction, and the
 * SDK types what comes back as `unknown` precisely because nothing checked it.
 * So these tests are not about a model behaving badly — they are about the
 * shape of the door.
 *
 * **The address tests are the ones that matter most.** A fabricated URL is the
 * one wrong answer that survives review: it is well-formed, it looks like the
 * kind of page the person described, and a worker built on it fetches a
 * stranger's site on a schedule.
 */

const CANDIDATES = ["https://example.com/news", "https://example.com/notices"];

/** A complete, ordinary tool input. Each test spoils exactly one thing. */
function input(overrides: Record<string, unknown> = {}) {
  return {
    name: "Council notices",
    description: "Watches the notices page.",
    prompt: "Tell me what changed, in Japanese.",
    frequency: "daily",
    runAtMinutes: 540,
    runAtWeekday: null,
    runAtDay: null,
    ...overrides,
  };
}

function readPrompt(overrides: Record<string, unknown> = {}) {
  return readWorkerDraftToolResult(
    workerDraftToolNames.prompt,
    input(overrides),
    [],
  );
}

function readWebsite(
  overrides: Record<string, unknown> = {},
  candidates = CANDIDATES,
) {
  return readWorkerDraftToolResult(
    workerDraftToolNames.website,
    input({ urlCandidateIndex: 0, ...overrides }),
    candidates,
  );
}

describe("a draft this can use", () => {
  it("reads a prompt worker", () => {
    expect(readPrompt()).toEqual({
      status: "supported",
      draft: {
        kind: "prompt",
        name: "Council notices",
        description: "Watches the notices page.",
        prompt: "Tell me what changed, in Japanese.",
        frequency: "daily",
        runAtMinutes: 540,
        runAtWeekday: null,
        runAtDay: null,
      },
    });
  });

  it("reads a website worker, taking the address from the request", () => {
    expect(readWebsite()).toEqual({
      status: "supported",
      draft: {
        kind: "website",
        websiteUrl: "https://example.com/news",
        name: "Council notices",
        description: "Watches the notices page.",
        prompt: "Tell me what changed, in Japanese.",
        frequency: "daily",
        runAtMinutes: 540,
        runAtWeekday: null,
        runAtDay: null,
      },
    });
  });

  it("trims what it was given", () => {
    const result = readPrompt({ name: "  Spaced  ", prompt: "  Do it.  " });

    expect(result).toMatchObject({
      draft: { name: "Spaced", prompt: "Do it." },
    });
  });

  it("allows a description to be missing or empty", () => {
    expect(readPrompt({ description: undefined })).toMatchObject({
      draft: { description: "" },
    });
    expect(readPrompt({ description: "   " })).toMatchObject({
      draft: { description: "" },
    });
  });

  it.each(["manual", "daily", "weekly", "monthly"])(
    "accepts %s as a frequency",
    (frequency) => {
      expect(readPrompt({ frequency })).toMatchObject({ draft: { frequency } });
    },
  );

  /** Absent and null both mean "the person did not say". */
  it.each([undefined, null])("reads a missing time as %o", (value) => {
    expect(
      readPrompt({ runAtMinutes: value, runAtWeekday: value, runAtDay: value }),
    ).toMatchObject({
      draft: { runAtMinutes: null, runAtWeekday: null, runAtDay: null },
    });
  });

  it("accepts each schedule field at both ends of its range", () => {
    expect(readPrompt({ runAtMinutes: 0 })).toMatchObject({
      draft: { runAtMinutes: 0 },
    });
    expect(readPrompt({ runAtMinutes: 1_439 })).toMatchObject({
      draft: { runAtMinutes: 1_439 },
    });
    expect(readPrompt({ runAtWeekday: 6 })).toMatchObject({
      draft: { runAtWeekday: 6 },
    });
    expect(readPrompt({ runAtDay: 31 })).toMatchObject({
      draft: { runAtDay: 31 },
    });
  });

  /**
   * A key nothing reads is not a reason to throw away a usable proposal — the
   * fields are copied out by name, so an extra one reaches nothing.
   */
  it("ignores keys it was not looking for", () => {
    const result = readPrompt({ status: "active", nextRunAt: "2026-01-01" });

    expect(result).toMatchObject({ status: "supported" });
    expect(Object.keys((result as { draft: object }).draft).sort()).toEqual([
      "description",
      "frequency",
      "kind",
      "name",
      "prompt",
      "runAtDay",
      "runAtMinutes",
      "runAtWeekday",
    ]);
  });
});

describe("a draft this refuses", () => {
  const refuses = (read: () => unknown) => {
    expect(read).toThrow();
    try {
      read();
    } catch (error) {
      expect(isInvalidWorkerDraftResponse(error)).toBe(true);
    }
  };

  it("refuses a tool it does not offer", () => {
    refuses(() =>
      readWorkerDraftToolResult("create_email_worker_draft", input(), []),
    );
  });

  it.each([null, "a string", 42, ["an array"]])(
    "refuses %o in place of an object",
    (toolInput) => {
      refuses(() =>
        readWorkerDraftToolResult(workerDraftToolNames.prompt, toolInput, []),
      );
    },
  );

  it.each(["hourly", "Daily", "", "prompt", "every day"])(
    "refuses %o as a frequency",
    (frequency) => {
      refuses(() => readPrompt({ frequency }));
    },
  );

  it.each([undefined, null, 7, {}])("refuses %o as a frequency", (frequency) => {
    refuses(() => readPrompt({ frequency }));
  });

  it.each(["name", "prompt"])("refuses a missing %s", (field) => {
    refuses(() => readPrompt({ [field]: undefined }));
  });

  it.each(["name", "prompt"])("refuses a blank %s", (field) => {
    refuses(() => readPrompt({ [field]: "   " }));
  });

  it.each(["name", "description", "prompt"])(
    "refuses a non-string %s",
    (field) => {
      refuses(() => readPrompt({ [field]: 42 }));
    },
  );

  it.each(["name", "description", "prompt"] as const)(
    "refuses a %s past the limit the form would hold it to",
    (field) => {
      const tooLong = "a".repeat(workerFieldLimits[field] + 1);

      refuses(() => readPrompt({ [field]: tooLong }));
      expect(
        readPrompt({ [field]: "a".repeat(workerFieldLimits[field]) }),
      ).toMatchObject({ status: "supported" });
    },
  );

  it.each([
    ["runAtMinutes", -1],
    ["runAtMinutes", 1_440],
    ["runAtWeekday", -1],
    ["runAtWeekday", 7],
    ["runAtDay", 0],
    ["runAtDay", 32],
  ])("refuses %s of %o", (field, value) => {
    refuses(() => readPrompt({ [field]: value }));
  });

  it.each([
    ["runAtMinutes", 9.5],
    ["runAtMinutes", "540"],
    ["runAtWeekday", "1"],
    ["runAtDay", 1.5],
  ])("refuses a non-integer %s of %o", (field, value) => {
    refuses(() => readPrompt({ [field]: value }));
  });
});

/**
 * The address, and the one way it is allowed to arrive.
 *
 * A model cannot put a URL into a draft because there is nowhere to put one:
 * it chooses among addresses the request already contained, by number.
 */
describe("which page a website worker watches", () => {
  it("uses the only address there is, whatever index it was given", () => {
    const single = ["https://example.com/only"];

    expect(readWebsite({ urlCandidateIndex: 5 }, single)).toMatchObject({
      draft: { websiteUrl: "https://example.com/only" },
    });
  });

  it("uses the address the model pointed at", () => {
    expect(readWebsite({ urlCandidateIndex: 1 })).toMatchObject({
      draft: { websiteUrl: "https://example.com/notices" },
    });
  });

  it("asks for an address when the request had none", () => {
    expect(readWebsite({}, [])).toEqual({
      status: "needs_input",
      field: "websiteUrl",
      message: "Add the address of the page you want AutoOps to watch.",
    });
  });

  it("refuses an index that points at no address", () => {
    expect(() => readWebsite({ urlCandidateIndex: 2 })).toThrow();
    expect(() => readWebsite({ urlCandidateIndex: -1 })).toThrow();
  });

  it("refuses to guess when there is more than one and the model did not choose", () => {
    expect(() => readWebsite({ urlCandidateIndex: undefined })).toThrow();
  });

  /**
   * The property the whole design exists for: a URL the model wrote itself has
   * no route into the draft, whatever field it puts it in.
   */
  it("cannot be given an address that was not in the request", () => {
    const result = readWebsite({
      websiteUrl: "https://invented.example.org/",
      url: "https://invented.example.org/",
      urlCandidateIndex: 0,
    });

    expect(result).toMatchObject({
      draft: { websiteUrl: "https://example.com/news" },
    });
    expect(JSON.stringify(result)).not.toContain("invented.example.org");
  });
});

describe("a request AutoOps cannot do", () => {
  it("carries the model's reason back", () => {
    expect(
      readWorkerDraftToolResult(
        workerDraftToolNames.unsupported,
        { reason: "AutoOps cannot read email." },
        [],
      ),
    ).toEqual({ status: "unsupported", reason: "AutoOps cannot read email." });
  });

  it("still answers when the model gave no reason", () => {
    const result = readWorkerDraftToolResult(
      workerDraftToolNames.unsupported,
      {},
      [],
    );

    expect(result).toMatchObject({ status: "unsupported" });
    expect((result as { reason: string }).reason).not.toBe("");
  });

  it("is never a worker", () => {
    const result = readWorkerDraftToolResult(
      workerDraftToolNames.unsupported,
      { reason: "AutoOps cannot read email." },
      [],
    );

    expect(result).not.toHaveProperty("draft");
  });
});

/**
 * Reading addresses out of a sentence.
 *
 * Syntax only — nothing here decides whether an address can be reached, or
 * normalises it. `parseWatchUrl` still does both, when the worker is created.
 */
describe("addresses found in a request", () => {
  it("finds none in a request that names none", () => {
    expect(
      extractUrlCandidates("毎日このページを見て、変わったら教えて"),
    ).toEqual([]);
  });

  it("finds one", () => {
    expect(
      extractUrlCandidates("https://example.com/news を毎日見て"),
    ).toEqual(["https://example.com/news"]);
  });

  it("finds several, in the order they were written", () => {
    expect(
      extractUrlCandidates(
        "watch https://a.example.com/one and http://b.example.com/two daily",
      ),
    ).toEqual(["https://a.example.com/one", "http://b.example.com/two"]);
  });

  it("lists an address written twice only once", () => {
    expect(
      extractUrlCandidates("https://a.example.com/x and https://a.example.com/x"),
    ).toEqual(["https://a.example.com/x"]);
  });

  it.each([
    ["a full stop", "See https://example.com/news."],
    ["a comma", "See https://example.com/news, daily"],
    ["a Japanese full stop", "https://example.com/news。毎日見て"],
    ["a closing bracket", "(https://example.com/news)"],
  ])("drops %s that belongs to the sentence", (_label, text) => {
    expect(extractUrlCandidates(text)).toEqual(["https://example.com/news"]);
  });

  it("ignores anything that is not an http address", () => {
    expect(
      extractUrlCandidates("ftp://example.com/x file:///etc/passwd example.com"),
    ).toEqual([]);
  });

  it("leaves out an address longer than the field could hold", () => {
    const long = `https://example.com/${"a".repeat(workerFieldLimits.websiteUrl)}`;

    expect(extractUrlCandidates(long)).toEqual([]);
  });

  it("stops after ten", () => {
    const text = Array.from(
      { length: 15 },
      (_, index) => `https://example.com/${index}`,
    ).join(" ");

    expect(extractUrlCandidates(text)).toHaveLength(10);
  });
});
