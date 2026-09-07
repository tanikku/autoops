import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * The hire form has to be told which clock it is scheduling against.
 *
 * It is a client component, so it cannot read the account row itself — the zone
 * has to be handed to it here. If this page stopped passing it, the form would
 * still render and would simply stop naming the zone, which is the state that
 * produced a worker scheduled nine hours away from where its owner meant.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  getUserTimezone: vi.fn(),
  getUserLanguage: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
const metadataMocks = vi.hoisted(() => ({ getDocumentLanguage: vi.fn() }));

vi.mock("@/lib/i18n/server", () => ({
  getDocumentLanguage: metadataMocks.getDocumentLanguage,
}));

vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/users", () => ({
  getUserTimezone: mocks.getUserTimezone,
  getUserLanguage: mocks.getUserLanguage,
}));

const NewRoutinePage = (await import("@/app/dashboard/new/page")).default;
const { generateMetadata } = await import("@/app/dashboard/new/page");

/** One prop, as it was handed to whichever component was given it. */
function passedProp(node: ReactNode, name: string): unknown {
  let found: unknown;

  const walk = (current: unknown): void => {
    if (found !== undefined) {
      return;
    }

    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }

    if (!current || typeof current !== "object") {
      return;
    }

    const props = (current as { props?: Record<string, unknown> }).props;
    if (!props) {
      return;
    }

    if (name in props) {
      found = props[name];
      return;
    }

    walk(props.children);
  };

  walk(node);
  return found;
}

const passedTimezone = (node: ReactNode) => passedProp(node, "timezone");

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue("user-1");
  mocks.getUserTimezone.mockReset().mockResolvedValue("Asia/Tokyo");
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
});

describe("hire worker page", () => {
  it("hands the account's timezone to the form", async () => {
    expect(passedTimezone(await NewRoutinePage())).toBe("Asia/Tokyo");
  });

  it("reads it for the signed-in account", async () => {
    await NewRoutinePage();

    expect(mocks.getUserTimezone).toHaveBeenCalledWith("user-1");
  });

  it("passes UTC through unchanged when that is what the account is on", async () => {
    mocks.getUserTimezone.mockResolvedValue("UTC");

    expect(passedTimezone(await NewRoutinePage())).toBe("UTC");
  });
});

/**
 * The form has to be told which language it is written in, for the same reason
 * it has to be told the zone: it is a client component, and both live on the
 * account row.
 */
describe("the language the hire form is written in", () => {
  it("comes from the account", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    expect(passedProp(await NewRoutinePage(), "language")).toBe("ja");
  });

  it("is read for the signed-in account", async () => {
    await NewRoutinePage();

    expect(mocks.getUserLanguage).toHaveBeenCalledWith("user-1");
  });
});

/**
 * What a browser tab and a search result say this screen is.
 *
 * **The document declares a language and the title has to be in it.** The root
 * layout writes the account's language onto `<html>`; a title left in English
 * under `lang="ja"` is the one part of the page contradicting the attribute a
 * screen reader chooses its voice from.
 *
 * **The resolver is replaced, not re-tested.** Which language a request is in
 * is settled in `lib/i18n/server.test.ts`. What is checked here is the mapping
 * from a language to two strings — including that the English wording is
 * exactly what it has always been, because a correctness fix must not quietly
 * reword the product.
 */
describe("what the tab says", () => {
  it("keeps the English title and description exactly as they were", async () => {
    metadataMocks.getDocumentLanguage.mockResolvedValue("en");

    await expect(generateMetadata()).resolves.toMatchObject({
      title: "Hire Worker — Koqentra",
      description: "Add a new AI worker to your team.",
    });
  });

  it("says the same thing in Japanese when the account reads Japanese", async () => {
    metadataMocks.getDocumentLanguage.mockResolvedValue("ja");

    await expect(generateMetadata()).resolves.toMatchObject({
      title: "Worker を作成 — Koqentra",
      description: "新しい AI Worker をチームに追加します。",
    });
  });

  /** The product name is a name in both languages. */
  it("leaves the name untranslated in either language", async () => {
    for (const language of ["en", "ja"] as const) {
      metadataMocks.getDocumentLanguage.mockResolvedValue(language);

      expect((await generateMetadata()).title).toContain("Koqentra");
    }
  });
});
