import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * What Koqentra says about itself to somebody who has not signed in.
 *
 * **This is the page an overclaim does the most damage on.** It is the one
 * somebody reads before they can check anything, and until this checkpoint it
 * described a different product — recurring workflow automation — while the
 * thing behind the sign-in button reads a piece of writing and says where it
 * belongs. What is fixed here is the promise, and the two halves that make it
 * honest: what Koqentra does, and what it does not do with the result.
 *
 * **The sign-in destination is checked by calling the action, not by reading
 * the source.** The form's `action` is an ordinary function on the element the
 * page returns, so a test can invoke it with `signIn` replaced — no hook in
 * production code, and no assertion about how the file happens to be written.
 */

const mocks = vi.hoisted(() => ({ signIn: vi.fn() }));

vi.mock("@/auth", () => ({
  signIn: mocks.signIn,
  auth: vi.fn(),
  signOut: vi.fn(),
}));

const Home = (await import("@/app/page")).default;

type Query = { error?: string | string[] };

const tree = async (query: Query = {}) =>
  await Home({ searchParams: Promise.resolve(query) });

const render = async (query: Query = {}) =>
  renderToStaticMarkup(await tree(query));

/** The page as a reader sees it, with the markup taken out. */
const text = async (query: Query = {}) =>
  (await render(query)).replace(/<[^>]*>/g, " ");

/** The first `<form>` in the returned element tree, or null. */
function findForm(node: unknown): ReactElement | null {
  if (!node || typeof node !== "object") {
    return null;
  }

  const element = node as ReactElement & { props?: Record<string, unknown> };

  if (element.type === "form") {
    return element;
  }

  const children = element.props?.children;

  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findForm(child);

    if (found !== null) {
      return found;
    }
  }

  return null;
}

describe("what the product says it is", () => {
  it("names itself an editor", async () => {
    expect(await render()).toContain("Your AI content editor.");
  });

  it("says what it actually does, in one sentence", async () => {
    expect(await text()).toContain(
      "Paste text or a public URL. Koqentra evaluates X, Reddit, and long-form, recommends what is worth using, and drafts the copy.",
    );
  });

  /**
   * **The first question an editor that writes posts invites.** Somebody
   * handing over unpublished writing deserves to be told what happens to it
   * before they hand it over, not only in a policy page.
   */
  it("says plainly that it publishes nothing", async () => {
    expect(await text()).toContain(
      "You decide what to use. Nothing is posted automatically.",
    );
  });

  it.each([
    "Automate recurring AI workflows.",
    "Create AI routines once. Run forever.",
  ])("no longer says %o", async (old) => {
    expect(await text()).not.toContain(old);
  });
});

/**
 * **Only what runs today.** Koqentra holds no social account, sends nothing
 * anywhere, measures nothing, and builds no lasting picture of anybody —
 * `CreatorMemory` exists in the schema and no code reads or writes it.
 *
 * **The denial is not the claim.** "Nothing is posted automatically" contains
 * the word *automatically*, so a check for that word alone would fail on the
 * one sentence that makes the page honest. These look for the assertions
 * instead, and the test below keeps the denial itself present.
 */
describe("what it must not promise", () => {
  it.each([
    "automatically post",
    "automatically publish",
    "we post for you",
    "posts for you",
    "connect your social",
    "learns your",
    "remembers your",
    "memory",
    "analytics",
    "track performance",
    "engagement",
  ])("does not claim %o", async (claim) => {
    expect((await text()).toLowerCase()).not.toContain(claim);
  });

  it("keeps the denial that those checks are written around", async () => {
    expect((await text()).toLowerCase()).toContain(
      "nothing is posted automatically",
    );
  });
});

/**
 * **Where sign-in lands, proved by running the action.** Creator is what the
 * product opens on now; the Worker dashboard is still at `/dashboard` and
 * still in the nav.
 */
describe("signing in", () => {
  it("sends somebody to Creator", async () => {
    mocks.signIn.mockClear();

    const form = findForm(await tree());
    const action = (form?.props as { action?: () => Promise<void> })?.action;

    expect(typeof action).toBe("function");

    await action?.();

    expect(mocks.signIn).toHaveBeenCalledTimes(1);
    expect(mocks.signIn).toHaveBeenCalledWith("google", {
      redirectTo: "/creator",
    });
  });

  it("does not send them to the Worker dashboard", async () => {
    mocks.signIn.mockClear();

    const form = findForm(await tree());
    await (form?.props as { action?: () => Promise<void> })?.action?.();

    expect(JSON.stringify(mocks.signIn.mock.calls)).not.toContain("/dashboard");
  });

  it("offers Google as the way in", async () => {
    expect(await text()).toContain("Continue with Google");
  });
});

/**
 * **A refusal says the beta is invite-only and nothing else.** Naming the
 * account would confirm to whoever holds it that it exists, and the query
 * Auth.js appends carries the error's type alone.
 */
describe("when sign-in was refused", () => {
  const REFUSED =
    "Koqentra is in Closed Beta and sign-in is limited to invited accounts.";

  it("says so, unchanged", async () => {
    expect(await text({ error: "AccessDenied" })).toContain(REFUSED);
  });

  it("says nothing of the kind to an ordinary visitor", async () => {
    expect(await text()).not.toContain(REFUSED);
  });

  it.each(["@", "allowlist", "invited accounts:"])(
    "names no address or list — %o",
    async (leak) => {
      expect(await text({ error: "AccessDenied" })).not.toContain(leak);
    },
  );
});

describe("what the page keeps", () => {
  it("keeps the name", async () => {
    expect(await render()).toContain("Koqentra");
  });

  it("keeps the privacy notice one click away", async () => {
    expect(await render()).toContain('href="/privacy"');
  });

  /** The repository link is unchanged here; renaming it is not this change. */
  it("keeps the source link where it was", async () => {
    expect(await render()).toContain('href="https://github.com/tanikku/autoops"');
  });

  it("keeps the beta footer", async () => {
    expect(await text()).toContain("Closed Beta");
  });
});

/**
 * A headline that wraps is a headline that fits. Nothing here is measured —
 * what is fixed is that no width is written into the markup, which is how a
 * landing page starts overflowing on a phone.
 */
describe("on a narrow screen", () => {
  it("writes no fixed width", async () => {
    const html = await render();

    expect(html).not.toMatch(/style="[^"]*width/);
    expect(html).not.toMatch(/w-\[\d/);
  });

  it("lets the long sentences balance rather than run off", async () => {
    expect(await render()).toContain("text-balance");
  });
});
