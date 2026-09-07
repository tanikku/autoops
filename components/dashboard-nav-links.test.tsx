import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which of the three links says the reader is standing on it.
 *
 * **This is the deferred half of a correctness fix.** `aria-current="page"` was
 * once hard-coded on the Worker link, so a screen reader was told Dashboard was
 * the current page while somebody stood on Creator or Settings — a wrong answer
 * given confidently. It was removed rather than guessed at, leaving the bar
 * accurate and silent. What is checked here is the part that was missing: the
 * route, and only then a claim.
 *
 * **Two claims, not one.** These links point at section roots. On `/creator`
 * the Creator link is genuinely the current page; on `/creator/new` it is not —
 * it is the section the current page sits inside, which is what `location`
 * says. The distinction is the whole reason this file is long.
 */

const mocks = vi.hoisted(() => ({ usePathname: vi.fn() }));

vi.mock("next/navigation", () => ({ usePathname: mocks.usePathname }));

const { DashboardNavLinks } = await import("@/components/dashboard-nav-links");

/**
 * **The labels arrive already translated.** This component takes words rather
 * than a language, so that the dictionaries stay on the server rather than
 * being shipped to every signed-in page to render three links. What the words
 * are in each language is the server's test to make; these are stand-ins that
 * are obviously not translations, so a test asserting on them cannot
 * accidentally start asserting on the dictionary.
 */
const LABELS = {
  creatorLabel: "CREATOR-LABEL",
  workersLabel: "WORKERS-LABEL",
  settingsLabel: "SETTINGS-LABEL",
} as const;

const render = (
  pathname: string,
  labels: Record<string, string> = LABELS,
) => {
  mocks.usePathname.mockReturnValue(pathname);

  return renderToStaticMarkup(
    <DashboardNavLinks
      creatorLabel={labels.creatorLabel}
      workersLabel={labels.workersLabel}
      settingsLabel={labels.settingsLabel}
    />,
  );
};

/**
 * What the anchor for one destination claims, or null.
 *
 * **Read off the `<a>` rather than the component tree.** `aria-current` is only
 * useful on the element a reader actually lands on; asserting it anywhere else
 * would pass while the rendered link said nothing.
 */
function claim(html: string, href: string): string | null {
  const anchor = html.match(new RegExp(`<a[^>]*href="${href}"[^>]*>`));

  expect(anchor, `no anchor for ${href}`).not.toBeNull();

  return anchor?.[0].match(/aria-current="([a-z]+)"/)?.[1] ?? null;
}

const CREATOR = "/creator";
const WORKERS = "/dashboard";
const SETTINGS = "/dashboard/settings";

beforeEach(() => {
  mocks.usePathname.mockReset();
});

describe("standing on a section's own page", () => {
  it.each([
    ["Creator", CREATOR],
    ["Workers", WORKERS],
    ["Settings", SETTINGS],
  ])("says %s is the current page", (_name, root) => {
    expect(claim(render(root), root)).toBe("page");
  });
});

describe("standing somewhere inside a section", () => {
  /**
   * The link is not this page — it is the section this page is in. Saying
   * `page` here would tell a reader they are somewhere they are not.
   */
  it.each([
    "/creator/new",
    "/creator/history",
  ])("says Creator is the location for %s", (pathname) => {
    expect(claim(render(pathname), CREATOR)).toBe("location");
  });

  it.each([
    "/dashboard/new",
    "/dashboard/runs/run-1",
    "/dashboard/workers/worker-1",
    "/dashboard/workers/worker-1/edit",
  ])("says Workers is the location for %s", (pathname) => {
    expect(claim(render(pathname), WORKERS)).toBe("location");
  });

  it("says Settings is the location for a page beneath it", () => {
    expect(claim(render("/dashboard/settings/anything"), SETTINGS)).toBe(
      "location",
    );
  });
});

/**
 * **Settings lives inside Workers, and only one of them may claim the reader.**
 * `/dashboard/settings` starts with `/dashboard`, so a shallower test would
 * mark both — and a screen reader would be told the reader is in two places.
 */
describe("the section that lives inside another", () => {
  it("gives Settings the claim and leaves Workers silent", () => {
    const html = render(SETTINGS);

    expect(claim(html, SETTINGS)).toBe("page");
    expect(claim(html, WORKERS)).toBeNull();
  });

  it("does the same one level deeper", () => {
    const html = render("/dashboard/settings/anything");

    expect(claim(html, SETTINGS)).toBe("location");
    expect(claim(html, WORKERS)).toBeNull();
  });
});

/**
 * **`startsWith` alone would be wrong, and this is where it shows.** A route
 * belongs to a section when it is that section's root or continues past a `/`.
 * `/creatorish` does neither.
 */
describe("paths that merely begin the same way", () => {
  it.each([
    ["/creatorish", CREATOR],
    ["/dashboardish", WORKERS],
    ["/dashboard/settingsish", SETTINGS],
  ])("claims nothing for %s", (pathname, root) => {
    expect(claim(render(pathname), root)).toBeNull();
  });

  it("does not let a look-alike fall through to the parent section", () => {
    const html = render("/dashboardish");

    for (const root of [CREATOR, WORKERS, SETTINGS]) {
      expect(claim(html, root)).toBeNull();
    }
  });
});

/**
 * **Not knowing is an answer.** The landing page and the privacy notice are
 * outside this bar, and so is anything added later; claiming one of the three
 * anyway would be guessing.
 */
describe("routes the bar does not cover", () => {
  it.each(["/", "/privacy", "/something-added-later"])(
    "claims nothing on %s",
    (pathname) => {
      const html = render(pathname);

      expect(html).not.toContain("aria-current");
    },
  );

  it("claims nothing when the pathname cannot be read", () => {
    mocks.usePathname.mockReturnValue(undefined);

    const html = renderToStaticMarkup(<DashboardNavLinks {...LABELS} />);

    expect(html).not.toContain("aria-current");
  });
});

describe("never two at once", () => {
  it.each([
    CREATOR,
    "/creator/new",
    WORKERS,
    "/dashboard/new",
    SETTINGS,
    "/dashboard/settings/anything",
  ])("marks exactly one link on %s", (pathname) => {
    const html = render(pathname);

    expect(html.match(/aria-current=/g) ?? []).toHaveLength(1);
  });
});

/**
 * The split moved these links into a client component; what they are and where
 * they go did not change.
 */
describe("what the links still are", () => {
  it("keeps the three destinations in order", () => {
    const html = render(CREATOR);

    const creator = html.indexOf(`href="${CREATOR}"`);
    const workers = html.indexOf(`href="${WORKERS}"`);
    const settings = html.indexOf(`href="${SETTINGS}"`);

    expect(creator).toBeGreaterThan(-1);
    expect(workers).toBeGreaterThan(creator);
    expect(settings).toBeGreaterThan(workers);
  });

  /**
   * **Whatever it is handed, in the order it was handed.** Looking a label up
   * here would mean importing the translation system — and shipping both
   * dictionaries to the browser for three words. The words come in already
   * resolved, and the server's own test is where the language is checked.
   */
  it("shows the labels it was given", () => {
    const html = render(CREATOR);

    expect(html).toContain("CREATOR-LABEL");
    expect(html).toContain("WORKERS-LABEL");
    expect(html).toContain("SETTINGS-LABEL");
  });

  it("puts each label on its own destination", () => {
    const html = render(CREATOR);

    expect(html.indexOf("CREATOR-LABEL")).toBeLessThan(
      html.indexOf("WORKERS-LABEL"),
    );
    expect(html.indexOf("WORKERS-LABEL")).toBeLessThan(
      html.indexOf("SETTINGS-LABEL"),
    );
  });

  /** Japanese words are strings like any other; nothing here inspects them. */
  it("renders labels in any script unchanged", () => {
    const html = render(CREATOR, {
      creatorLabel: "クリエイター",
      workersLabel: "ワーカー",
      settingsLabel: "設定",
    });

    expect(html).toContain("クリエイター");
    expect(html).toContain("ワーカー");
    expect(html).toContain("設定");
  });

  /**
   * Three links, an account name and a sign out do not fit on a 375px row. The
   * wrapping came with them across the boundary.
   */
  it("keeps the wrapping the narrow screen needs", () => {
    const html = render(CREATOR);

    expect(html).toContain("flex-wrap");
    expect(html).toContain("sm:flex-nowrap");
    expect(html).toContain("order-last");
    expect(html).toContain("sm:order-none");
  });

  /**
   * **Nothing about the reader crosses the boundary.** The language is the only
   * prop; a session, an id or an address here would be a client component
   * holding something the server had no reason to hand it.
   */
  it("shows no account details", () => {
    const html = render(CREATOR);

    expect(html).not.toContain("@");
  });
});
