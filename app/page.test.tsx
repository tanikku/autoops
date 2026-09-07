import { beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * **`redirect` is replaced with something that throws, because the real one
 * does.** Next.js implements it by throwing a control-flow error the framework
 * catches, and everything after the call is unreachable. A mock that merely
 * recorded the call would let the page carry on rendering the English landing
 * underneath it — and the test would pass while the very thing it exists to
 * prevent still happened.
 */
class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect(${to})`);
    this.name = "RedirectSignal";
  }
}

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  auth: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/auth", () => ({
  signIn: mocks.signIn,
  auth: mocks.auth,
  signOut: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

const Home = (await import("@/app/page")).default;

beforeEach(() => {
  mocks.signIn.mockReset();
  // Signed out unless a test says otherwise: the landing page's own audience.
  mocks.auth.mockReset().mockResolvedValue(null);
  mocks.redirect.mockReset().mockImplementation((to: string) => {
    throw new RedirectSignal(to);
  });
});

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

/**
 * Who this page is for, and who is sent past it.
 *
 * **The regression this closes is a document-language one.** The root layout
 * now declares the account's language on `<html>`, and everything on this page
 * is written in English only. A Japanese account opening `/` would therefore
 * be handed English copy inside a document claiming to be Japanese — worse
 * than the plain English page it replaced, because the markup is now
 * confidently wrong. Not rendering it for them is what removes the state
 * rather than making it rarer.
 */
describe("who the landing page is for", () => {
  it("shows a visitor with no session the page, as before", async () => {
    mocks.auth.mockResolvedValue(null);

    expect(await render()).toContain("Your AI content editor.");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("sends a signed-in reader to the screen the product opens on", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "test-user" } });

    await expect(tree()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mocks.redirect).toHaveBeenCalledWith("/creator");
  });

  /**
   * **The English landing must not be rendered underneath the redirect.** This
   * is the assertion that would fail if `redirect` were ever called without
   * leaving the function — the whole point of the change.
   */
  it("renders none of the English landing for them", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "test-user" } });

    const thrown = await tree().catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(RedirectSignal);
    expect((thrown as RedirectSignal).to).toBe("/creator");
  });

  /**
   * A session object without a usable id is not somebody signed in — the shape
   * an expired or half-established session can arrive in. Treating it as an
   * account would send a visitor to a screen that would only bounce them back.
   */
  it.each([
    ["a session with no user", {}],
    ["a user with no id", { user: {} }],
  ])("treats %s as signed out", async (_name, session) => {
    mocks.auth.mockResolvedValue(session);

    expect(await render()).toContain("Your AI content editor.");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  /**
   * **A refused sign-in leaves no session**, so the message it comes back for
   * is still reachable. The allowlist rejects before a token is minted — there
   * is nothing to redirect on — and this is the case that would break if the
   * boundary above were ever widened past "is there a session".
   */
  it("still shows a refused visitor why they were turned away", async () => {
    mocks.auth.mockResolvedValue(null);

    expect(await text({ error: "AccessDenied" })).toContain(
      "sign-in is limited to invited accounts",
    );
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
