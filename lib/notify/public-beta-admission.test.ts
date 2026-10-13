import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailDeliveryError } from "@/lib/notify/email";
import { notifyPublicBetaJoin, publicBetaJoinEmail } from "@/lib/notify/public-beta-admission";

/**
 * The operator's note about a new Public Beta place.
 *
 * The provider is replaced at `sendPlainTextEmail`; what it does with a message
 * is `email.test.ts`'s. This fixes who is written to, what is said, and that
 * nothing escapes — neither an error nor anything about the person.
 */

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@/lib/notify/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/email")>()),
  sendPlainTextEmail: mocks.send,
}));

const OPERATOR = "ops@example.test";
// 2026-10-14 12:04:05 in Tokyo.
const JOIN = { participants: 3, limit: 10, admittedAt: new Date("2026-10-14T03:04:05Z") };

let saved: string | undefined;
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  saved = process.env.PUBLIC_BETA_NOTIFY_EMAIL;
  process.env.PUBLIC_BETA_NOTIFY_EMAIL = OPERATOR;
  mocks.send.mockReset().mockResolvedValue(undefined);
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (saved === undefined) delete process.env.PUBLIC_BETA_NOTIFY_EMAIL;
  else process.env.PUBLIC_BETA_NOTIFY_EMAIL = saved;
  logged.mockRestore();
});

describe("the message", () => {
  it("names the count and the cap in the subject", () => {
    expect(publicBetaJoinEmail(JOIN).subject).toBe(
      "[Koqentra] Public Beta participant joined (3/10)",
    );
  });

  it("says participants, remaining and the time in JST", () => {
    expect(publicBetaJoinEmail(JOIN).text).toBe(
      [
        "Koqentra Public Beta",
        "",
        "A new participant joined.",
        "",
        "Participants: 3 / 10",
        "Remaining: 7",
        "Joined at: 2026-10-14 12:04:05 JST",
      ].join("\n"),
    );
  });

  it("says nothing about the person, even if handed more than it asks for", () => {
    const join = { ...JOIN, userId: "google-sub-123", email: "new@example.com", name: "Someone" };
    const { subject, text } = publicBetaJoinEmail(join);

    expect(`${subject}\n${text}`).not.toMatch(/google-sub-123|@|Someone/);
  });
});

describe("sending it", () => {
  it("sends once, to the operator address only", async () => {
    await notifyPublicBetaJoin(JOIN);

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith({ to: OPERATOR, ...publicBetaJoinEmail(JOIN) });
  });

  it("trims the configured address", async () => {
    process.env.PUBLIC_BETA_NOTIFY_EMAIL = `  ${OPERATOR}\n`;

    await notifyPublicBetaJoin(JOIN);

    expect(mocks.send.mock.calls[0][0].to).toBe(OPERATOR);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("sends nothing and says nothing when the address is %s", async (_label, value) => {
    if (value === undefined) delete process.env.PUBLIC_BETA_NOTIFY_EMAIL;
    else process.env.PUBLIC_BETA_NOTIFY_EMAIL = value;

    await expect(notifyPublicBetaJoin(JOIN)).resolves.toBeUndefined();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
  });

  it("does not read SUPPORT_EMAIL", async () => {
    delete process.env.PUBLIC_BETA_NOTIFY_EMAIL;
    const support = process.env.SUPPORT_EMAIL;
    process.env.SUPPORT_EMAIL = "support@example.test";

    try {
      await notifyPublicBetaJoin(JOIN);
      expect(mocks.send).not.toHaveBeenCalled();
    } finally {
      if (support === undefined) delete process.env.SUPPORT_EMAIL;
      else process.env.SUPPORT_EMAIL = support;
    }
  });

  it.each(["not-configured", "timeout", "network", "rejected", "unreadable"] as const)(
    "logs only the reason when delivery fails as %s",
    async (reason) => {
      mocks.send.mockRejectedValue(new EmailDeliveryError(reason));

      await expect(notifyPublicBetaJoin(JOIN)).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith("[public-beta-notify] could not send", `reason=${reason}`);
    },
  );

  it("logs an unexpected failure as unknown, without its words or the address", async () => {
    mocks.send.mockRejectedValue(new Error(`provider said 422 for ${OPERATOR} with re_secret_key`));

    await expect(notifyPublicBetaJoin(JOIN)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith("[public-beta-notify] could not send", "reason=unknown");
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/ops@|422|secret|provider/);
  });
});
