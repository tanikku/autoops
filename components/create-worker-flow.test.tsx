import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Hiring a worker by purpose.
 *
 * Rendered to static markup like the other form suites: each purpose is opened
 * through `initialPurpose`, which is the same state a card click sets.
 */

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/app/dashboard/new/actions", () => ({
  createRoutineAction: vi.fn(),
  generateWorkerDraftAction: vi.fn(),
}));
vi.mock("@/components/notification/use-action-result", () => ({
  useActionResult: () => {},
}));

const { CreateWorkerFlow } = await import("@/components/create-worker-flow");
type Purpose = Parameters<typeof CreateWorkerFlow>[0]["initialPurpose"];
const { t } = await import("@/lib/i18n");

function render(
  initialPurpose: Purpose = null,
  language = "ja",
  extra: Partial<Parameters<typeof CreateWorkerFlow>[0]> = {},
) {
  return renderToStaticMarkup(
    <CreateWorkerFlow
      timezone="Asia/Tokyo"
      language={language}
      initialPurpose={initialPurpose}
      {...extra}
    />,
  );
}

/** The opening tag of the element with this id. */
function tag(html: string, id: string): string {
  return new RegExp(`<[a-z]+ id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
}

/** The options of the frequency select, in order. */
function frequencyOptions(html: string): string[] {
  const select = /<select[^>]*name="frequency"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
  return [...select.matchAll(/value="([^"]+)"/g)].map((match) => match[1]);
}

describe("the first screen", () => {
  it.each(["ja", "en"])("asks what the person is waiting for, in %s", (language) => {
    const html = render(null, language);

    expect(html).toContain(t(language, "create.purpose.heading"));
    for (const key of [
      "create.purpose.hotel.title",
      "create.purpose.restock.title",
      "create.purpose.website.title",
      "create.purpose.free.title",
    ] as const) {
      expect(html).toContain(t(language, key));
    }
  });

  /** Not "what are you waiting for": a worker also finds things and does AI work. */
  it("asks what Koqentra should handle, not only what to watch", () => {
    expect(render(null, "ja")).toContain("どんなことをKoqentraに任せますか？");
    expect(render(null, "en")).toContain("What would you like Koqentra to handle?");
  });

  it("offers no price-drop or application card yet, and no form", () => {
    const html = render();

    expect(html).not.toContain("値下がり");
    expect(html).not.toContain("募集");
    expect(html).not.toContain("<form");
  });

  it("puts the AI draft away until the person builds their own", () => {
    expect(render()).not.toContain(t("ja", "worker.create.draftHeading"));
  });
});

describe("a hotel vacancy", () => {
  const html = render("hotel");

  it("shows its own fields, helper and limits", () => {
    expect(html).toContain(t("ja", "template.hotel.title"));
    expect(html).toContain(t("ja", "template.hotel.helper"));
    expect(html).toContain(t("ja", "template.hotel.limitation"));
    expect(html).toContain('name="stayDate"');
    expect(html).toContain('name="room"');
    expect(html).toContain('name="maxPrice"');
    expect(html).toContain('name="notes"');
    expect(html).toContain('name="websiteUrl"');
    expect(html).toContain('name="templateId" value="hotel-availability"');
  });

  it("sends no prompt, condition or kind of its own", () => {
    expect(html).not.toContain('name="prompt"');
    expect(html).not.toContain('name="targetCondition"');
    expect(html).not.toContain('name="kind"');
  });

  it("offers every 6 hours, every 3 hours and daily, defaulting to 6 hours", () => {
    expect(frequencyOptions(html)).toEqual(["every-6-hours", "every-3-hours", "daily"]);
    expect(html).toMatch(/<option value="every-6-hours" selected="">/);
  });

  it("asks for a starting time, and says what checking more often costs", () => {
    expect(html).toContain(t("ja", "worker.field.intervalRunAt"));
    expect(tag(html, "runAt")).toContain('required=""');
    expect(html).toContain(t("ja", "worker.field.frequencyAllowanceNote"));
  });

  it("offers email off, in its own words", () => {
    expect(html).toContain(t("ja", "template.common.emailLabel"));
    expect(tag(html, "emailNotificationsEnabled")).toContain('type="checkbox"');
    expect(tag(html, "emailNotificationsEnabled")).not.toContain("checked");
  });

  it("starts or drafts with two buttons, draft first in the document", () => {
    const draft = html.indexOf('value="draft"');
    const active = html.indexOf('value="active"');

    expect(html).toContain(t("ja", "template.common.start"));
    expect(html).toContain(t("ja", "template.common.saveDraft"));
    expect(draft).toBeGreaterThan(-1);
    expect(active).toBeGreaterThan(draft);
    expect(html).not.toContain('name="status" class');
    expect(html).not.toMatch(/<select[^>]*name="status"/);
  });
});

describe("a product restock", () => {
  const html = render("restock");

  it("shows its own fields, helper and limits", () => {
    expect(html).toContain(t("ja", "template.restock.title"));
    expect(html).toContain(t("ja", "template.restock.helper"));
    expect(html).toContain(t("ja", "template.restock.limitation"));
    expect(html).toContain('name="product"');
    expect(html).toContain('name="variant"');
    expect(tag(html, "includePreorder")).toContain('value="true"');
    expect(tag(html, "includePreorder")).not.toContain("checked");
    expect(html).toContain('name="templateId" value="product-restock"');
    expect(html).not.toContain('name="stayDate"');
  });

  it("offers the same three cadences and the allowance note", () => {
    expect(frequencyOptions(html)).toEqual(["every-6-hours", "every-3-hours", "daily"]);
    expect(html).toContain(t("ja", "worker.field.frequencyAllowanceNote"));
  });
});

describe("the trial note", () => {
  const note = "TRIAL-NOTE";

  it("sits beside a template's start button", () => {
    const html = render("hotel", "ja", { trialNote: note });

    expect(html.indexOf(note)).toBeGreaterThan(html.indexOf('name="emailNotificationsEnabled"'));
    expect(html.indexOf(note)).toBeLessThan(html.indexOf('value="active"'));
  });

  it("sits above the other forms and the choice", () => {
    expect(render(null, "ja", { trialNote: note })).toContain(note);
    const html = render("free", "ja", { trialNote: note });

    expect(html.indexOf(note)).toBeLessThan(html.indexOf("<form"));
  });
});

describe("other page changes", () => {
  const html = render("website");

  it("is the website form on its own", () => {
    expect(html).toContain('<input type="hidden" name="kind" value="website"/>');
    expect(html).toContain('name="websiteUrl"');
    expect(html).toContain('name="targetCondition"');
    expect(html).not.toContain(t("ja", "worker.create.draftHeading"));
    expect(html).not.toContain(t("ja", "worker.create.kindHeading"));
    expect(html).not.toContain('name="templateId"');
  });

  it("keeps every cadence the generic form offers", () => {
    expect(frequencyOptions(html)).toEqual([
      "manual",
      "daily",
      "weekly",
      "monthly",
      "every-3-hours",
      "every-6-hours",
    ]);
  });
});

describe("building your own", () => {
  const html = render("free");

  it("is the previous screen: the draft, the kinds and the examples", () => {
    expect(html).toContain(t("ja", "worker.create.draftHeading"));
    expect(html).toContain(t("ja", "worker.create.kindHeading"));
    expect(html).toContain(t("ja", "worker.create.templatesHeading"));
    expect(html).toContain('value="discovery"');
    expect(html).not.toContain('name="templateId"');
  });

  it("keeps discovery as the YouTube recommendation it is", () => {
    expect(html).toContain(t("ja", "worker.kind.discoveryOption"));
  });
});
