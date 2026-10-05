import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The seller's notice, in both languages.
 *
 * **Substrings, not a snapshot.** What is fixed is what the notice must keep
 * saying: the three prices, the four items disclosed on request, how to ask,
 * cancellation and refunds, and the trial's rules and limits.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getUserLanguage: vi.fn(),
  supportMailtoHref: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/users", () => ({ getUserLanguage: mocks.getUserLanguage }));
vi.mock("@/lib/support", () => ({ supportMailtoHref: mocks.supportMailtoHref }));

const LegalPage = (await import("@/app/legal/page")).default;
const { generateMetadata } = await import("@/app/legal/page");

const html = async () => renderToStaticMarkup(await LegalPage({}));
const text = async () => (await html()).replace(/<[^>]*>/g, " ");

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue(null);
  mocks.getUserLanguage.mockReset();
  mocks.supportMailtoHref
    .mockReset()
    .mockImplementation(
      (subject: string) => `mailto:support@example.test?subject=${encodeURIComponent(subject)}`,
    );
});

describe("who may read it", () => {
  it("renders for a visitor with no session, without reading a language", async () => {
    const body = await text();

    expect(body).toContain("Legal notice");
    expect(mocks.getUserLanguage).not.toHaveBeenCalled();
  });

  it("renders in Japanese for a Japanese account", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getUserLanguage.mockResolvedValue("ja");

    expect(await text()).toContain("特定商取引法に基づく表記");
  });

  it("has a title and description", async () => {
    const metadata = await generateMetadata({});

    expect(String(metadata.title)).toContain("Koqentra");
    expect(metadata.description).toBeTruthy();
  });
});

describe("the Japanese notice", () => {
  beforeEach(() => {
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getUserLanguage.mockResolvedValue("ja");
  });

  it("states the three prices", async () => {
    const body = await text();

    expect(body).toContain("Lite: 月額 780円");
    expect(body).toContain("Standard: 月額 1,480円");
    expect(body).toContain("Pro: 月額 2,480円");
    expect(body).not.toMatch(/税込|税別/);
  });

  it("discloses the four items on request, and says how to ask", async () => {
    const body = await text();

    for (const label of ["販売事業者名", "運営責任者", "所在地", "電話番号"]) {
      expect(body).toContain(label);
    }
    expect(body.match(/請求があれば遅滞なく開示します/g)?.length).toBeGreaterThanOrEqual(4);
    expect(body).toContain("開示請求は下記の問い合わせ先までご連絡ください");
    expect(await html()).toContain('href="mailto:support@example.test');
  });

  it("states payment, renewal, cancellation and refunds", async () => {
    const body = await text();

    expect(body).toContain("Stripe Checkout");
    expect(body).toContain("1か月ごとに自動更新");
    expect(body).toContain("Stripe Billing Portal");
    expect(body).toContain("現在の請求期間の終了までは利用できます");
    expect(body).toContain("原則として返金は行いません");
    expect(body).toContain("重複請求");
  });

  it("states the trial's length, limits and what buying during it does", async () => {
    const body = await text();

    expect(body).toContain("14日間のトライアル");
    expect(body).toContain("独立したプラン");
    expect(body).toContain("同時に稼働できるWorker数: 3");
    expect(body).toContain("AI処理: 30");
    expect(body).toContain("手動実行: 20");
    expect(body).toContain("YouTubeおすすめ探し: 14");
    expect(body).toContain("その時点でトライアルは終了");
    expect(body).toContain("持ち越されません");
    expect(body).toContain("0 から開始");
  });
});

describe("the English notice", () => {
  it("states the same facts", async () => {
    const body = await text();

    expect(body).toContain("¥780 per month");
    expect(body).toContain("¥1,480 per month");
    expect(body).toContain("¥2,480 per month");
    expect(body.match(/Disclosed without delay upon request/g)?.length).toBe(4);
    expect(body).toContain("Stripe Billing Portal");
    expect(body).toContain("payments are not refunded");
    expect(body).toContain("14-day trial");
    expect(body).toContain("Workers active at once: 3");
    expect(body).toContain("not carried over");
  });

  it("says a contact is being prepared rather than linking nowhere", async () => {
    mocks.supportMailtoHref.mockReturnValue(null);

    const body = await text();

    expect(body).toContain("A contact address is being prepared.");
    expect(await html()).not.toContain("mailto:");
  });
});

/**
 * **Either language, without signing in.** `?lang=` decides first, so a
 * visitor with no session can reach the Japanese text; an unknown value falls
 * back as if there were none.
 */
describe("choosing the language on the page", () => {
  const page = (lang?: string) =>
    LegalPage({ searchParams: Promise.resolve(lang === undefined ? {} : { lang }) });
  const pageText = async (lang?: string) =>
    renderToStaticMarkup(await page(lang)).replace(/<[^>]*>/g, " ");

  beforeEach(() => {
    mocks.auth.mockResolvedValue(null);
  });

  it("shows the Japanese text to a visitor with no session who asks for it", async () => {
    const body = await pageText("ja");

    expect(body).toContain("請求があれば遅滞なく開示します");
    expect(mocks.getUserLanguage).not.toHaveBeenCalled();
  });

  it("shows the English text when asked, even to a Japanese account", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getUserLanguage.mockResolvedValue("ja");

    expect(await pageText("en")).toContain("Disclosed without delay upon request");
  });

  it("falls back as if nothing were asked for an unknown language", async () => {
    expect(await pageText("fr")).toContain("Disclosed without delay upon request");
  });

  it("offers a link to the other language and marks the current one", async () => {
    const ja = renderToStaticMarkup(await page("ja"));
    const en = renderToStaticMarkup(await page("en"));

    expect(ja).toContain('href="/legal?lang=en"');
    expect(ja).toContain('aria-current="true"');
    expect(en).toContain('href="/legal?lang=ja"');
  });

  it("titles the tab in the language asked for", async () => {
    const metadata = await generateMetadata({ searchParams: Promise.resolve({ lang: "ja" }) });

    expect(String(metadata.title)).toContain("特定商取引法に基づく表記");
  });
});
