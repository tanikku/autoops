import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Hiring a worker by purpose.
 *
 * Rendered to static markup like the other form suites: each purpose is opened
 * through `initialPurpose`, which is the same state a card click sets.
 */

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
const actions = vi.hoisted(() => ({
  createRoutineAction: vi.fn(),
  generateWorkerDraftAction: vi.fn(),
}));
vi.mock("@/app/dashboard/new/actions", () => actions);
vi.mock("@/components/notification/use-action-result", () => ({
  useActionResult: () => {},
}));

const { CreateWorkerFlow } = await import("@/components/create-worker-flow");
type Purpose = Parameters<typeof CreateWorkerFlow>[0]["initialPurpose"];
const { t } = await import("@/lib/i18n");
type TranslationKey = Parameters<typeof t>[1];

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

/** The value of the hidden input with this name, or null when there is none. */
function hidden(html: string, name: string): string | null {
  return new RegExp(`<input type="hidden" name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? null;
}

const PRIMARY = ["create.purpose.web.title", "create.purpose.ai.title"] as const;

const RECOMMENDED = [
  "create.purpose.municipal.title",
  "create.purpose.price.title",
  "create.purpose.careers.title",
] as const;

const OTHERS = [
  "create.purpose.hotel.title",
  "create.purpose.restock.title",
  "create.purpose.website.title",
  "create.purpose.youtube.title",
  "create.purpose.free.title",
] as const;

const WEB_CHOICES = [
  ...RECOMMENDED,
  "create.purpose.hotel.title",
  "create.purpose.restock.title",
  "create.purpose.website.title",
] as const;

/** Where each key's words first appear, as rendered (apostrophes escaped). */
function positions(html: string, language: string, keys: readonly TranslationKey[]): number[] {
  return keys.map((key) => html.indexOf(t(language, key).replaceAll("'", "&#x27;")));
}

function inOrder(found: number[]): boolean {
  return found.every((position) => position > -1) &&
    [...found].sort((a, b) => a - b).every((position, index) => position === found[index]);
}

describe("the first screen", () => {
  it.each(["ja", "en"])(
    "leads with web watching, then AI work, then three recommended watches, in %s",
    (language) => {
      const html = render(null, language);

      expect(html).toContain(t(language, "create.purpose.heading"));
      expect(html).toContain(t(language, "create.purpose.recommended.heading"));
      expect(inOrder(positions(html, language, [...PRIMARY, ...RECOMMENDED]))).toBe(true);
    },
  );

  it("words the two main cards and the three recommendations as agreed", () => {
    const html = render(null, "ja");

    expect(html).toContain("Webページの変化を知らせる");
    expect(html).toContain("指定したWebページを定期的に確認し、前回からの変化を検知します。");
    expect(html).toContain("AIに定期的な仕事を任せる");
    expect(html).toContain("登録した指示に沿って、AIが文章作成や分析を定期的に実行します。");
    for (const [title, detail] of [
      ["自治体のお知らせ", "募集・イベント・手続きの変更"],
      ["商品価格・再入荷", "価格や在庫表示の変化"],
      ["採用・募集情報", "求人情報や応募条件の変更"],
    ]) {
      expect(html).toContain(title);
      expect(html).toContain(detail);
    }
  });

  /** Reordered, not removed: every earlier way in is still one click away. */
  it.each(["ja", "en"])("keeps every other use under a toggle, in %s", (language) => {
    const html = render(null, language);
    const details = /<details[^>]*>([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";

    expect(details).toMatch(/^<summary/);
    expect(details).toContain(t(language, "create.purpose.others.toggle"));
    expect(inOrder(positions(details, language, OTHERS))).toBe(true);
    expect(html.indexOf("<details")).toBeGreaterThan(
      Math.max(...positions(html, language, RECOMMENDED)),
    );
  });

  it("makes every card one button", () => {
    const html = render();
    const buttons = html.match(/<button type="button"/g) ?? [];

    expect(buttons).toHaveLength(PRIMARY.length + RECOMMENDED.length + OTHERS.length);
    expect(html).toContain("focus-visible:ring-3");
  });

  it("says what a draft, a first check and the next run mean", () => {
    const html = render();

    expect(html).toContain(t("ja", "create.purpose.guide.draft"));
    expect(html).toContain(t("ja", "create.purpose.guide.firstCheck"));
    expect(html).toContain(t("ja", "create.purpose.guide.nextRun"));
  });

  it("offers no price-drop card and no form", () => {
    const html = render();

    expect(html).not.toContain("値下がり");
    expect(html).not.toContain("<form");
  });

  it("puts the AI draft away until the person builds their own", () => {
    expect(render()).not.toContain(t("ja", "worker.create.draftHeading"));
  });

  it("says the video search is YouTube's", () => {
    expect(t("ja", "create.purpose.youtube.description")).toContain("YouTube");
    expect(t("en", "create.purpose.youtube.description")).toContain("YouTube");
  });
});

describe("watching a web page", () => {
  it.each(["ja", "en"])("offers the six watches, recommended first, in %s", (language) => {
    const html = render("web", language);

    expect(html).toContain(t(language, "create.purpose.web.heading"));
    expect(inOrder(positions(html, language, WEB_CHOICES))).toBe(true);
    expect(html).not.toContain("<form");
  });

  it("goes back to the first choice from here", () => {
    expect(render("web")).toContain(t("ja", "create.purpose.back"));
  });

  it.each(["municipal", "price", "careers", "hotel", "restock", "website"] as const)(
    "goes back to the web choices from %s",
    (purpose) => {
      const html = render(purpose);

      expect(html).toContain(t("ja", "create.purpose.backToWeb"));
      expect(html).not.toContain(t("ja", "create.purpose.back"));
    },
  );
});

describe("checking a product's price", () => {
  const html = render("price");

  it("is the generic website form with the existing product-page example applied", () => {
    expect(hidden(html, "kind")).toBe("website");
    expect(html).toContain(`value="${t("ja", "template.productPage.name")}"`);
    expect(html).toContain("この商品ページで変わったところを、簡潔に分かりやすくまとめてください。");
    expect(html).toContain('name="websiteUrl"');
  });

  it("adds no condition, no template origin and no draft", () => {
    expect(tag(html, "targetCondition")).not.toContain("value=");
    expect(html).not.toContain('name="templateId"');
    expect(html).not.toContain(t("ja", "worker.create.draftHeading"));
  });
});

describe.each([
  ["municipal", "template.municipalNotices.name"],
  ["careers", "template.careersPage.name"],
] as const)("the recommended %s watch", (purpose, nameKey) => {
  const html = render(purpose);

  it("is the generic website form with its existing example applied", () => {
    expect(hidden(html, "kind")).toBe("website");
    expect(html).toContain(`value="${t("ja", nameKey)}"`);
    expect(html).toContain('name="websiteUrl"');
  });

  it("adds no template origin, no draft and no kind picker", () => {
    expect(html).not.toContain('name="templateId"');
    expect(html).not.toContain(t("ja", "worker.create.draftHeading"));
    expect(html).not.toContain(t("ja", "worker.create.kindHeading"));
  });
});

describe("recurring AI work", () => {
  const html = render("ai");

  it("is the generic prompt form with the existing idea example applied", () => {
    expect(hidden(html, "kind")).toBe("prompt");
    expect(html).toContain(`value="${t("ja", "template.ideaGenerator.name")}"`);
    expect(html).toContain("下のテーマについて、新しいアイデアを5つ考えてください。");
  });

  it("drafts nothing, records no template origin, and shows no kind picker", () => {
    expect(actions.generateWorkerDraftAction).not.toHaveBeenCalled();
    expect(actions.createRoutineAction).not.toHaveBeenCalled();
    expect(html).not.toContain('name="templateId"');
    expect(html).not.toContain(t("ja", "worker.create.draftHeading"));
    expect(html).not.toContain(t("ja", "worker.create.kindHeading"));
  });
});

describe("finding YouTube videos", () => {
  const html = render("youtube");

  it("is the generic discovery form with the existing recommendation example applied", () => {
    expect(hidden(html, "kind")).toBe("discovery");
    expect(hidden(html, "discoverySource")).toBe("youtube");
    expect(html).toContain(`value="${t("ja", "template.recommendationFinder.name")}"`);
    expect(html).toContain('name="discoveryQuery"');
    expect(html).not.toContain('name="templateId"');
  });

  it("says it searches YouTube only, not the whole web", () => {
    expect(html).toContain(t("ja", "create.purpose.youtube.note"));
    expect(t("ja", "create.purpose.youtube.note")).toContain("YouTube");
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
    expect(hidden(html, "kind")).toBe("website");
    expect(tag(html, "name")).not.toContain("value=");
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
