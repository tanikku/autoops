import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// The note lives with the form that shows it, and that form reaches the edit
// action on the way in. Nothing here asks the auth module anything — this only
// keeps reading one string from pulling in a framework runtime.
vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));

const { WorkerFields } = await import("@/components/worker-fields");
const { BASELINE_RESET_NOTE } = await import("@/components/worker-edit-form");

/**
 * Which fields a worker is asked for, and what they are called.
 *
 * The same component serves both kinds and both forms, so what separates them
 * is a prop rather than a copy of the markup — which is exactly the sort of
 * thing that drifts silently. Rendering it to a string is the smallest way to
 * ask: no DOM, no renderer beyond the one React already ships for the server,
 * and no new dependency.
 */

function render(props: Parameters<typeof WorkerFields>[0]) {
  return renderToStaticMarkup(<WorkerFields {...props} />);
}

describe("a prompt worker's fields", () => {
  const html = render({ values: {} });

  it("asks for a prompt, in those words", () => {
    expect(html).toContain(">Prompt<");
    expect(html).toContain("Instructions sent to the AI on every run.");
  });

  it("does not ask what to do when a page changes", () => {
    expect(html).not.toContain("When the page changes");
    expect(html).not.toContain("What should the AI do when this page changes?");
  });

  /**
   * The address input stays in the page so that switching kind on the hire form
   * does not empty a box that was already filled in — but inside a container
   * `display: none` removes from the screen and from the accessibility tree
   * with it. Present in the markup is not the same as asked for.
   */
  it("keeps the address input out of sight rather than out of the page", () => {
    const hidden = html.slice(html.indexOf('<div class="hidden">'));

    expect(html).toContain('<div class="hidden">');
    expect(hidden).toContain('name="websiteUrl"');
    expect(hidden).toContain("Website address");
  });

  it("says nothing about a baseline, even when a note is supplied", () => {
    const withNote = render({ values: {}, websiteUrlNote: BASELINE_RESET_NOTE });

    // Not the bare word: `items-baseline` is a layout class on this very form.
    expect(withNote).not.toContain("comparison baseline");
  });
});

describe("a website worker's fields", () => {
  const html = render({
    kind: "website",
    values: {
      websiteUrl: "https://example.com/news",
      prompt: "Tell me what changed.",
    },
  });

  it("asks for the address, and fills in the one already stored", () => {
    expect(html).toContain("Website address");
    expect(html).toContain('value="https://example.com/news"');
  });

  it("asks what to do about a change, rather than for a prompt", () => {
    expect(html).toContain("When the page changes");
    expect(html).toContain("What should the AI do when this page changes?");
    expect(html).not.toContain("Instructions sent to the AI on every run.");
  });

  it("keeps the schedule and status fields every worker has", () => {
    expect(html).toContain('name="frequency"');
    expect(html).toContain('name="status"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="description"');
  });

  it("shows a note about the address when one is given", () => {
    const withNote = render({
      kind: "website",
      values: {},
      websiteUrlNote: BASELINE_RESET_NOTE,
    });

    expect(withNote).toContain(
      "Changing the address resets the comparison baseline.",
    );
  });
});

/**
 * What the note is allowed to promise.
 *
 * The mechanism it describes is invisible — a row disappears and a later run
 * behaves differently — so the sentence is the only account of it anyone gets,
 * and each clause has to survive the cases it does not mention. A check that
 * fails writes no baseline. Saving the form fetches nothing. Nothing is
 * deleted except the comparison point.
 */
describe("what the note about changing an address says", () => {
  it("promises a baseline only once a check has succeeded", () => {
    expect(BASELINE_RESET_NOTE).toContain("next successful check");
  });

  it("names establishing a baseline as the alternative to reporting a change", () => {
    expect(BASELINE_RESET_NOTE).toContain(
      "establishes a new baseline instead of treating the new page as a detected change",
    );
  });

  it("says the runs already recorded stay", () => {
    expect(BASELINE_RESET_NOTE).toContain("Past runs are kept");
  });

  /**
   * The claims it must not make: a check that always works, history being
   * removed, a fetch or a model call caused by saving.
   */
  it.each([
    "The next check",
    "deleted",
    "removed",
    "immediately",
    "right away",
    "AI",
  ])("does not claim %o", (phrase) => {
    expect(BASELINE_RESET_NOTE).not.toContain(phrase);
  });
});
