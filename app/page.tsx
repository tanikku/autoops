import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GitHubIcon } from "@/components/icons";
import { readAccessMode, readPublicBetaSignup } from "@/lib/beta-access";
import { getPlanDefinition } from "@/lib/plans";

/**
 * Also the page a refused sign-in comes back to.
 *
 * `auth.ts` names this as the error page, so Auth.js returns here with
 * `?error=AccessDenied` when the beta allowlist turned somebody away. **What
 * it appends is the error's type and nothing else** — no address and no list —
 * and the sentence below says no more than that either: naming the account
 * would confirm to whoever is holding it that it exists.
 *
 * Reading the query makes this page dynamic rather than prerendered, which is
 * the accepted cost of the visitor being told anything at all.
 */
const SIGNUP_FULL_NOTICE = {
  ja: "Public Betaの受付上限に達しました。受付再開までお待ちください。",
  en: "Public Beta has reached its current signup limit. Please check back when registration reopens.",
};

const SIGNUP_CLOSED_NOTICE = {
  ja: "Public Betaの新規受付は現在停止しています。受付再開までお待ちください。",
  en: "Public Beta signup is currently closed. Please check back when registration reopens.",
};

/**
 * **In Japanese, the language the page is written in.** The document's own
 * `lang` is English for anybody signed out (`app/layout.tsx`), so the page
 * declares Japanese on its outermost element instead of changing what every
 * other anonymous page says.
 */
export const metadata: Metadata = {
  title: "Koqentra — 毎日の確認作業を、AIに任せる",
  description:
    "指定したWebページの変更確認や、定期的なAI処理をWorkerに任せられます。文章の分析やSNS向け投稿案の作成にはCreatorも利用できます。",
};

/** The trial's numbers come from the plan catalogue, never from this page. */
const TRIAL = getPlanDefinition("trial");

const USE_CASES = [
  { title: "自治体のお知らせ", detail: "募集・イベント・手続きの変更を確認" },
  { title: "商品価格・再入荷", detail: "価格や在庫表示の変化を確認" },
  { title: "採用・募集情報", detail: "求人情報や応募条件の変更を確認" },
];

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; signup?: string | string[] }>;
}) {
  // **Somebody signed in is not the audience for this page.** It introduces
  // Koqentra to a person who has not seen it; the screen the product opens on
  // is where an account belongs.
  //
  // **The session, and nothing more.** No account row is read and none is
  // created: `auth()` decodes what the request already carries, and a visitor
  // without it falls straight through to the page. That matters most for a
  // refused sign-in — the beta allowlist mints no token, so there is no session
  // here and the message below is exactly what they see.
  const session = await auth();

  if (session?.user?.id) {
    // **Home, not the screen the product used to open on.** Sending a signed-in
    // visitor to Creator meant the marketing page dropped them mid-task; Home is
    // where they can see what is going on and choose.
    redirect("/dashboard");
  }

  const { error, signup } = await searchParams;
  // **A new participant who could not be taken in**, and only that: an existing
  // account is let in before the mode or the cap is looked at, so it never
  // lands here. A Closed Beta refusal comes back as Auth.js's `AccessDenied`
  // and is told it is closed, like a Public Beta whose signup is off. There is
  // no account language before sign-in, so both languages are shown.
  const signupNotice =
    signup === "full"
      ? SIGNUP_FULL_NOTICE
      : signup === "closed" || error === "AccessDenied"
        ? SIGNUP_CLOSED_NOTICE
        : null;

  // **Read the same way `auth.ts` reads them, and only to describe.** The cap
  // shown is the configured total, never a count of places left: that would
  // need the admissions table, and a number that moves under the reader is one
  // this page could not keep true.
  const accessMode = readAccessMode(process.env.AUTH_ACCESS_MODE);
  const publicBetaSignup = readPublicBetaSignup({
    PUBLIC_BETA_SIGNUP_ENABLED: process.env.PUBLIC_BETA_SIGNUP_ENABLED,
    PUBLIC_BETA_SIGNUP_LIMIT: process.env.PUBLIC_BETA_SIGNUP_LIMIT,
  });
  const publicBeta = accessMode === "public-beta";
  const betaLabel = publicBeta ? "Public Beta" : "Closed Beta";

  return (
    <div lang="ja" className="flex flex-1 flex-col bg-background">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6 sm:px-10">
        <span className="text-lg font-semibold tracking-tight">Koqentra</span>
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={
            <a
              href="https://github.com/tanikku/autoops"
              target="_blank"
              rel="noopener noreferrer"
            />
          }
        >
          <GitHubIcon className="size-4" />
          GitHub
        </Button>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-16 sm:px-10 sm:py-24">
        <section className="flex flex-col items-center text-center">
          <p className="text-sm font-medium text-muted-foreground">{betaLabel}</p>
          <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            毎日の確認作業を、AIに任せる。
          </h1>

          {/* **Only what the product does today.** A worker fetches one page it
              was given, or runs one instruction on a schedule; Creator reads
              what it is given and drafts. Nothing holds a social account or
              posts anything. A landing page is where an overclaim does the most
              damage, because it is the one somebody agrees to before they can
              check. */}
          <p className="mt-6 text-balance text-lg text-muted-foreground">
            指定したWebページの変更確認や、定期的なAI処理をWorkerに任せられます。
          </p>
          <p className="mt-2 text-balance text-base text-muted-foreground">
            文章の分析やSNS向け投稿案の作成には、Creatorも利用できます。
          </p>

          {signupNotice ? (
            <div
              role="status"
              className="mt-8 max-w-md text-balance rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground"
            >
              <p lang="ja">{signupNotice.ja}</p>
              <p lang="en" className="mt-1">
                {signupNotice.en}
              </p>
            </div>
          ) : null}

          <div className="mt-10 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
            <form
              action={async () => {
                "use server";
                // **Only where a normal sign-in lands.** A visitor who was sent
                // here from a protected route arrives with a `callbackUrl`, and
                // Auth.js prefers that over this — which is what keeps a deep
                // link returning to where it was asked for.
                await signIn("google", { redirectTo: "/dashboard" });
              }}
              className="w-full sm:w-auto"
            >
              {/* "Register", not "start a trial": signing in starts nothing.
                  The trial begins when the first worker is switched on. */}
              <Button type="submit" size="lg" className="w-full sm:w-auto">
                Googleで無料登録して試す
              </Button>
            </form>
            <Button
              variant="outline"
              size="lg"
              className="w-full sm:w-auto"
              nativeButton={false}
              render={
                <a
                  href="https://github.com/tanikku/autoops"
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              <GitHubIcon className="size-4" />
              GitHub
            </Button>
          </div>
        </section>

        <section aria-labelledby="features-heading" className="mt-20">
          <h2 id="features-heading" className="text-xl font-semibold tracking-tight">
            できること
          </h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>
                  <h3>Worker</h3>
                </CardTitle>
                <CardDescription>Webページの変更確認や定期的なAI処理。</CardDescription>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>
                  <h3>Creator</h3>
                </CardTitle>
                <CardDescription>
                  文章の分析、投稿先の適性判断、投稿案の作成。使うかどうかはあなたが決めます。自動で投稿することはありません。
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </section>

        <section aria-labelledby="use-cases-heading" className="mt-12">
          <h2 id="use-cases-heading" className="text-xl font-semibold tracking-tight">
            利用例
          </h2>
          <ul className="mt-4 grid gap-3 sm:grid-cols-3">
            {USE_CASES.map((item) => (
              <li key={item.title} className="rounded-xl border border-border px-4 py-3">
                <p className="font-medium">{item.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="beta-heading" className="mt-12">
          <h2 id="beta-heading" className="text-xl font-semibold tracking-tight">
            {betaLabel}について
          </h2>
          {publicBeta ? (
            <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-muted-foreground">
              {publicBetaSignup.enabled && publicBetaSignup.limit > 0 ? (
                <li>
                  受付上限は{publicBetaSignup.limit}名です。上限に達した時点で新規受付を締め切ります。
                </li>
              ) : (
                <li>現在、新規受付は停止しています。</li>
              )}
              <li>Googleアカウントでログインして参加します。</li>
              <li>
                最初のWorkerを「有効」にした時点で、{TRIAL.trialDurationDays}
                日間の無料トライアルが始まります。登録しただけでは始まりません。
              </li>
              <li>
                トライアル中の利用枠：同時に稼働できるWorker {TRIAL.activeWorkerLimit}件、AI処理{" "}
                {TRIAL.aiProcessingLimit}回、手動実行 {TRIAL.manualRunLimit}回、YouTubeおすすめ探し{" "}
                {TRIAL.discoveryLimit}回。
              </li>
              <li>
                トライアル終了後、Workerは実行されなくなります。Worker・履歴・設定は保存されたままで、自動で料金が発生することはありません。
              </li>
            </ul>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              現在は招待制です。招待されたGoogleアカウントでのみ参加できます。
            </p>
          )}
        </section>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-6 py-8 text-center text-sm text-muted-foreground sm:px-10">
        © {new Date().getFullYear()} Koqentra · {betaLabel} ·{" "}
        <Link href="/privacy" className="underline-offset-4 hover:underline">
          プライバシーポリシー
        </Link>{" "}
        ·{" "}
        <Link href="/terms" className="underline-offset-4 hover:underline">
          利用規約
        </Link>{" "}
        ·{" "}
        <Link href="/legal" className="underline-offset-4 hover:underline">
          特定商取引法に基づく表記
        </Link>
      </footer>
    </div>
  );
}
