import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The terms of service, in both languages.
 *
 * **Substrings, not a snapshot**: the sections and the commitments they make.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getUserLanguage: vi.fn(),
  supportMailtoHref: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/users", () => ({ getUserLanguage: mocks.getUserLanguage }));
vi.mock("@/lib/support", () => ({ supportMailtoHref: mocks.supportMailtoHref }));

const TermsPage = (await import("@/app/terms/page")).default;
const { generateMetadata } = await import("@/app/terms/page");

const html = async () => renderToStaticMarkup(await TermsPage());
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

describe("who may read them", () => {
  it("renders for a visitor with no session", async () => {
    expect(await text()).toContain("Terms of Service");
    expect(mocks.getUserLanguage).not.toHaveBeenCalled();
  });

  it("has a title and description", async () => {
    const metadata = await generateMetadata();

    expect(String(metadata.title)).toContain("Koqentra");
    expect(metadata.description).toBeTruthy();
  });
});

describe("the Japanese terms", () => {
  beforeEach(() => {
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getUserLanguage.mockResolvedValue("ja");
  });

  it("has all nineteen sections, in order", async () => {
    const body = await text();
    const titles = [
      "1. 適用", "2. アカウント", "3. サービス内容", "4. AI機能と出力",
      "5. ユーザー入力・処理対象", "6. 禁止事項", "7. 利用枠・レート制限",
      "8. トライアル", "9. 有料プラン・自動更新", "10. 解約", "11. 返金",
      "12. サービスの変更・停止", "13. 知的財産", "14. 免責", "15. 責任の制限",
      "16. アカウント停止・利用制限", "17. 規約変更", "18. 準拠法・管轄", "19. 問い合わせ",
    ];
    const positions = titles.map((title) => body.indexOf(title));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("states the AI disclaimer and the external-site caveat", async () => {
    const body = await text();

    expect(body).toContain("Claude API");
    expect(body).toContain("正確性、完全性、特定の目的への適合性は保証しません");
    expect(body).toContain("利用者自身が行う");
    expect(body).toContain("外部の Web サイト");
  });

  it("names the four allowances and says reaching one restricts use", async () => {
    const body = await text();

    for (const name of ["同時に稼働できるWorker数", "AI処理", "手動実行", "おすすめ探し"]) {
      expect(body).toContain(name);
    }
    expect(body).toContain("レート制限");
    expect(body).toContain("利用は制限されます");
  });

  it("states the trial, renewal, cancellation and refunds", async () => {
    const body = await text();

    expect(body).toContain("14日間のトライアル");
    expect(body).toContain("独立したプラン");
    expect(body).toContain("持ち越されません");
    expect(body).toContain("1か月ごとに自動更新");
    expect(body).toContain("Stripe Billing Portal");
    expect(body).toContain("現在の請求期間の終了までは有料プランを利用できます");
    expect(body).toContain("原則として返金は行いません");
  });

  it("lists prohibited uses and keeps rights in user content with the user", async () => {
    const body = await text();

    expect(body).toContain("法令に違反する行為");
    expect(body).toContain("不正アクセス");
    expect(body).toContain("過度な自動アクセス");
    expect(body).toContain("利用者が入力したコンテンツの権利は利用者に留まり");
  });

  it("is governed by Japanese law without naming a particular court", async () => {
    const body = await text();

    expect(body).toContain("日本法に準拠します");
    expect(body).toContain("日本国内の裁判所");
    expect(body).not.toMatch(/地方裁判所|簡易裁判所/);
  });

  it("does not carry the closed-beta 'stop without notice' wording", async () => {
    expect(await text()).not.toContain("予告なく");
  });

  it("gives the contact", async () => {
    expect(await html()).toContain('href="mailto:support@example.test');
  });
});

describe("the English terms", () => {
  it("state the same commitments", async () => {
    const body = await text();

    expect(body).toContain("Claude API");
    expect(body).toContain("not guaranteed to be accurate");
    expect(body).toContain("Workers active at once");
    expect(body).toContain("Recommendation runs");
    expect(body).toContain("14-day");
    expect(body).toContain("renewed automatically every month");
    expect(body).toContain("Stripe Billing Portal");
    expect(body).toContain("payments are not refunded");
    expect(body).toContain("laws of Japan");
    expect(body).toContain("19. Contact");
    expect(body).not.toContain("without notice");
  });
});
