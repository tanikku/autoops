import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What an email about a finished run says, and what it refuses to say.
 *
 * **The provider and the owner's row are the only things stood in.** The
 * composition, the dictionary, the timestamp and the link are all the real
 * ones, so a sentence that reads wrong in either language fails here rather
 * than in somebody's inbox.
 *
 * **Nothing in this file can send anything.** `sendPlainTextEmail` is a spy;
 * the module it comes from is never loaded, so there is no path to `fetch` at
 * all.
 */

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getRecipient: vi.fn(),
}));

vi.mock("@/lib/notify/email", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/notify/email")>(
      "@/lib/notify/email",
    );

  return { ...actual, sendPlainTextEmail: mocks.send };
});

vi.mock("@/lib/users", () => ({
  getNotificationRecipient: mocks.getRecipient,
}));

const { notifyRunOutcome, MAX_NOTIFIED_OUTPUT_CHARS } = await import(
  "@/lib/notify/run-notification"
);
const { EmailDeliveryError } = await vi.importActual<
  typeof import("@/lib/notify/email")
>("@/lib/notify/email");
const { en } = await vi.importActual<typeof import("@/lib/i18n/en")>(
  "@/lib/i18n/en",
);
const { ja } = await vi.importActual<typeof import("@/lib/i18n/ja")>(
  "@/lib/i18n/ja",
);

const OWNER = {
  email: "owner@example.test",
  language: "en" as const,
  timezone: "Asia/Tokyo",
};

const FINISHED_AT = new Date("2026-08-31T00:50:00.000Z");

function notification(
  overrides: Partial<Parameters<typeof notifyRunOutcome>[0]> = {},
) {
  return {
    runId: "run-1",
    routineId: "worker-1",
    userId: "user-a",
    workerName: "Careers page",
    kind: "website-changed" as const,
    finishedAt: FINISHED_AT,
    output: "Two roles were added.",
    ...overrides,
  };
}

/** What the one send was asked to deliver. */
function sent() {
  return mocks.send.mock.calls[0][0] as {
    to: string;
    subject: string;
    text: string;
  };
}

let errors: string[] = [];

beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue(undefined);
  mocks.getRecipient.mockReset().mockResolvedValue({ ...OWNER });
  process.env.AUTH_URL = "https://autoops.example.test";
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  delete process.env.AUTH_URL;
  vi.restoreAllMocks();
});

describe("who it goes to", () => {
  it("asks for the owner of the run, by the id the routine carried", async () => {
    await notifyRunOutcome(notification({ userId: "user-a" }));

    expect(mocks.getRecipient).toHaveBeenCalledWith("user-a");
    expect(sent().to).toBe(OWNER.email);
  });

  it("writes to a different account's address when the owner is a different account", async () => {
    mocks.getRecipient.mockResolvedValue({
      ...OWNER,
      email: "other@example.test",
    });

    await notifyRunOutcome(notification({ userId: "user-b" }));

    expect(mocks.getRecipient).toHaveBeenCalledWith("user-b");
    expect(sent().to).toBe("other@example.test");
  });

  it("sends nothing when the owner cannot be read", async () => {
    mocks.getRecipient.mockResolvedValue(null);

    await notifyRunOutcome(notification());

    expect(mocks.send).not.toHaveBeenCalled();
    expect(errors.join(" ")).toContain("reason=recipient-unknown");
  });

  it("sends nothing when reading the owner throws", async () => {
    mocks.getRecipient.mockRejectedValue(new Error("connection refused"));

    await notifyRunOutcome(notification());

    expect(mocks.send).not.toHaveBeenCalled();
    expect(errors.join(" ")).toContain("reason=recipient-unknown");
  });
});

describe("the link back", () => {
  it("points at the run's own page, absolutely", async () => {
    await notifyRunOutcome(notification({ runId: "run-9" }));

    expect(sent().text).toContain(
      "https://autoops.example.test/dashboard/runs/run-9",
    );
  });

  it("does not double the slash when the base carries one", async () => {
    process.env.AUTH_URL = "https://autoops.example.test/";

    await notifyRunOutcome(notification({ runId: "run-9" }));

    expect(sent().text).toContain(
      "https://autoops.example.test/dashboard/runs/run-9",
    );
    expect(sent().text).not.toContain("test//dashboard");
  });

  it.each([
    ["unset", undefined],
    ["not an address", "not a url"],
    ["not something a reader can open", "mailto:someone@example.test"],
  ])("sends nothing when AUTH_URL is %s", async (_label, value) => {
    if (value === undefined) {
      delete process.env.AUTH_URL;
    } else {
      process.env.AUTH_URL = value;
    }

    await notifyRunOutcome(notification());

    expect(mocks.send).not.toHaveBeenCalled();
    expect(errors.join(" ")).toContain("reason=link-unavailable");
  });
});

describe("what a website change says", () => {
  it("names the worker in the subject, in English", async () => {
    await notifyRunOutcome(notification());

    expect(sent().subject).toBe('[Koqentra] "Careers page" detected a change');
  });

  it("names the worker in the subject, in Japanese", async () => {
    mocks.getRecipient.mockResolvedValue({ ...OWNER, language: "ja" });

    await notifyRunOutcome(notification());

    expect(sent().subject).toBe("[Koqentra]「Careers page」で変更を検出しました");
  });

  it("carries the worker, the time it was detected, the summary and the link", async () => {
    await notifyRunOutcome(notification());

    const text = sent().text;
    expect(text).toContain("Koqentra");
    expect(text).toContain("Worker: Careers page");
    expect(text).toContain("Detected at: 2026-08-31 09:50 Asia/Tokyo");
    expect(text).toContain("Two roles were added.");
    expect(text).toContain("/dashboard/runs/run-1");
  });
});

describe("what a finished prompt worker says", () => {
  it("says it completed, in English", async () => {
    await notifyRunOutcome(notification({ kind: "prompt-completed" }));

    expect(sent().subject).toBe('[Koqentra] "Careers page" completed');
    expect(sent().text).toContain("Executed at: 2026-08-31 09:50 Asia/Tokyo");
  });

  it("says it completed, in Japanese", async () => {
    mocks.getRecipient.mockResolvedValue({ ...OWNER, language: "ja" });

    await notifyRunOutcome(notification({ kind: "prompt-completed" }));

    expect(sent().subject).toBe("[Koqentra]「Careers page」が完了しました");
    expect(sent().text).toContain("実行日時: 2026-08-31 09:50 Asia/Tokyo");
  });

  /** An answer of nothing is still an answer, and nothing is written for it. */
  it("sends an empty output as an empty output", async () => {
    await notifyRunOutcome(notification({ kind: "prompt-completed", output: "" }));

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(sent().text).toContain("Worker: Careers page");
  });
});

describe("what a failure says", () => {
  it("says the run failed and points at the page, in English", async () => {
    await notifyRunOutcome(notification({ kind: "failed", output: "" }));

    expect(sent().subject).toBe('[Koqentra] "Careers page" failed');
    expect(sent().text).toContain("The run failed. Open Koqentra for details.");
  });

  it("says the run failed and points at the page, in Japanese", async () => {
    mocks.getRecipient.mockResolvedValue({ ...OWNER, language: "ja" });

    await notifyRunOutcome(notification({ kind: "failed", output: "" }));

    expect(sent().subject).toBe("[Koqentra]「Careers page」の実行に失敗しました");
    expect(sent().text).toContain(
      "実行に失敗しました。詳しい内容は Koqentra で確認してください。",
    );
  });

  /**
   * **A diagnostic is not a message.** Even if something handed one through as
   * the output, a failure's body is the fixed sentence and nothing else.
   */
  it("never forwards what the failure said", async () => {
    await notifyRunOutcome(
      notification({
        kind: "failed",
        output: "Connection to db-prod-1.internal refused",
      }),
    );

    expect(sent().text).not.toContain("db-prod-1.internal");
  });
});

describe("the account's own material", () => {
  it("does not translate what a model wrote", async () => {
    mocks.getRecipient.mockResolvedValue({ ...OWNER, language: "ja" });

    await notifyRunOutcome(
      notification({ output: "Two roles were added to the careers page." }),
    );

    expect(sent().text).toContain("Two roles were added to the careers page.");
  });

  it("does not translate the worker's name", async () => {
    mocks.getRecipient.mockResolvedValue({ ...OWNER, language: "ja" });

    await notifyRunOutcome(notification({ workerName: "Careers page" }));

    expect(sent().subject).toContain("Careers page");
  });

  it("carries an output that fits, exactly as it is", async () => {
    const output = "a".repeat(MAX_NOTIFIED_OUTPUT_CHARS);

    await notifyRunOutcome(notification({ output }));

    expect(sent().text).toContain(output);
    expect(sent().text).not.toContain("The rest is available in Koqentra.");
  });

  it("cuts an output that does not fit and says where the rest is", async () => {
    const output = "b".repeat(MAX_NOTIFIED_OUTPUT_CHARS + 500);

    await notifyRunOutcome(notification({ output }));

    expect(sent().text).toContain("b".repeat(MAX_NOTIFIED_OUTPUT_CHARS));
    expect(sent().text).not.toContain("b".repeat(MAX_NOTIFIED_OUTPUT_CHARS + 1));
    expect(sent().text).toContain("The rest is available in Koqentra.");
  });
});

describe("the subject line", () => {
  /**
   * **Not a header-injection fix** — the request is JSON and there is no header
   * to break out of. What it fixes is a subject that reads as broken.
   */
  it("folds newlines and control characters out of a worker's name", async () => {
    await notifyRunOutcome(
      notification({ workerName: "Careers\r\nBcc: someone@example.test" }),
    );

    expect(sent().subject).not.toContain("\n");
    expect(sent().subject).not.toContain("\r");
    expect(sent().subject).toBe(
      '[Koqentra] "Careers Bcc: someone@example.test" detected a change',
    );
  });

  it("keeps a name shorter than the form's own limit", async () => {
    await notifyRunOutcome(notification({ workerName: "x".repeat(400) }));

    expect(sent().subject).toContain("x".repeat(100));
    expect(sent().subject).not.toContain("x".repeat(101));
  });
});

describe("when the send itself fails", () => {
  it.each([
    "not-configured",
    "timeout",
    "network",
    "rejected",
    "unreadable",
  ] as const)("does not throw, and names %s in the log", async (reason) => {
    mocks.send.mockRejectedValue(new EmailDeliveryError(reason));

    await expect(notifyRunOutcome(notification())).resolves.toBeUndefined();
    expect(errors.join(" ")).toContain(`reason=${reason}`);
  });

  it("does not throw for something it did not anticipate", async () => {
    mocks.send.mockRejectedValue(new Error("something else"));

    await expect(notifyRunOutcome(notification())).resolves.toBeUndefined();
    expect(errors.join(" ")).toContain("reason=unknown");
  });

  /**
   * **The line is two ids and a word.** Everything worth knowing about the run
   * is in the database under those ids; nothing that could not be written down
   * is written down.
   */
  it("logs the run and the worker, and nothing about anybody", async () => {
    mocks.send.mockRejectedValue(new EmailDeliveryError("rejected"));

    await notifyRunOutcome(
      notification({ output: "Two roles were added.", workerName: "Careers page" }),
    );

    const line = errors.join(" ");
    expect(line).toContain("[notify] could not send");
    expect(line).toContain("run=run-1");
    expect(line).toContain("worker=worker-1");
    expect(line).not.toContain(OWNER.email);
    expect(line).not.toContain("Two roles were added.");
    expect(line).not.toContain("Careers page");
    expect(line).not.toContain("autoops.example.test");
  });
});

/**
 * The keys this feature added, held to the same parity as every other one.
 *
 * The dictionary-wide check in `lib/i18n/index.test.ts` already fails on a
 * missing key; this says which keys an email is composed from, so removing one
 * silently is not possible either.
 */
describe("the words an email is made of", () => {
  const keys = [
    "notify.email.changedSubject",
    "notify.email.completedSubject",
    "notify.email.failedSubject",
    "notify.email.worker",
    "notify.email.detectedAt",
    "notify.email.executedAt",
    "notify.email.failedBody",
    "notify.email.truncated",
    "notify.email.viewRun",
  ] as const;

  it.each(keys)("has %s in both languages", (key) => {
    expect(en[key]).toBeTruthy();
    expect(ja[key]).toBeTruthy();
  });
});
