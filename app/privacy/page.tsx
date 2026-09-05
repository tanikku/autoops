import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import { DEFAULT_LANGUAGE, t, type Language } from "@/lib/i18n";
import { supportMailtoHref } from "@/lib/support";
import { getUserLanguage } from "@/lib/users";

export const metadata: Metadata = {
  title: "Privacy — Koqentra",
  description: "What Koqentra stores, where it goes, and what it does not do.",
};

/**
 * What Koqentra actually does with what it holds.
 *
 * **Every sentence here describes something in the code.** A privacy notice
 * that promises deletion nobody implemented, or retention nothing enforces, is
 * worse than none: it is a claim the software will not keep. Where the
 * behaviour is absent — account deletion, expiry — this says so rather than
 * describing the version of it somebody would prefer.
 */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-medium tracking-tight">{title}</h2>
      <div className="mt-3 flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </section>
  );
}

type Passage = { title: string; body: React.ReactNode };

type PrivacyCopy = {
  heading: string;
  intro: string;
  closedBeta: Passage;
  signIn: Passage;
  provide: Passage;
  use: Passage;
  ai: Passage;
  email: Passage;
  creator: Passage;
  creatorDoesNot: Passage;
  storage: Passage;
  run: Passage;
  logs: Passage;
  retention: Passage;
  deleteWorker: Passage;
  deleteAccount: Passage;
  availability: Passage;
  aiOutput: Passage;
  contact: Passage;
  changes: Passage;
  back: string;
};

/**
 * The notice itself, in both languages, kept beside the page.
 *
 * **Page-local rather than in `lib/i18n`.** Almost none of these sentences is
 * reused anywhere else: a page-length legal text moved into the shared
 * dictionary would grow a file every screen imports, for the sake of one route.
 * The two labels this page really does share with Settings — the support
 * subject and the support action — still come from `t()`, because those are the
 * same words in both places.
 *
 * **Both languages state the same facts.** The Japanese is a translation, not a
 * summary: where the English names a limit, a retention gap, or something
 * Koqentra does not do, the Japanese names it too. Softening one of them would
 * hand people who read Japanese a different privacy notice.
 */
const PRIVACY_COPY = {
  en: {
    heading: "Privacy",
    intro: "What Koqentra receives, where it is kept, and what it does with it.",
    closedBeta: {
      title: "Koqentra is in Closed Beta",
      body: (
        <p>
          Access is by invitation. The service is being tried out rather than
          operated, and it may change or stop without notice.
        </p>
      ),
    },
    signIn: {
      title: "What we receive when you sign in",
      body: (
        <p>
          Signing in goes through Google. Koqentra receives the account
          identifier Google issues for you, your email address, your name, and
          the URL of your profile picture. The identifier is what everything you
          create is filed under.
        </p>
      ),
    },
    provide: {
      title: "What you provide",
      body: (
        <p>
          A worker is a name, an optional description, and a prompt. You also
          choose a timezone for your account, which decides both how times are
          displayed and when scheduled workers run.
        </p>
      ),
    },
    use: {
      title: "How it is used",
      body: (
        <p>
          To run your workers, to work out when a scheduled one is next due, and
          to show you the result. Koqentra uses this information to provide these
          features and does not sell it.
        </p>
      ),
    },
    ai: {
      title: "AI processing",
      body: (
        <p>
          Running a worker sends its prompt — the whole of it, with{" "}
          <code>{"{{today}}"}</code> and <code>{"{{now}}"}</code> already filled
          in — to Anthropic, which produces the result. Koqentra does not retry:
          a request that fails is recorded as a failure and the worker waits for
          its next turn.
        </p>
      ),
    },
    email: {
      title: "Email notifications",
      body: (
        <p>
          Email notifications are off unless you turn them on, and you turn them
          on for one worker at a time. While one is on, Koqentra sends a message
          to the address on your account — never to any other — when that
          worker&rsquo;s run finishes or fails. Sending goes through Resend,
          which receives your address, the worker&rsquo;s name, and up to two
          thousand characters of what the run produced. A message about a failed
          run carries no detail of the failure.
        </p>
      ),
    },
    creator: {
      title: "Analyzing your writing",
      body: (
        <>
          <p>
            When you ask Koqentra to analyze a piece of writing, the title and
            body you submit are sent to Anthropic, which decides — separately
            for X, Reddit and long-form — whether it is worth posting there and
            writes the post if it is.
          </p>
          <p>
            That request also carries what you have told Koqentra about your
            audience, goals and voice, together with your most recent answers to
            earlier analyses — at most the last twelve, not your whole history.
            Each of those answers can include the reason the AI gave, the post
            it proposed, the version you wrote if you edited it, a reason you
            gave if you gave one, and a short extract of the piece it was about.
          </p>
          <p>
            When an analysis succeeds, Koqentra stores the title and body you
            submitted, the decision for each of the three channels, the reason
            for each decision, and the post text for the channels it
            recommended.
          </p>
          <p>
            When you answer one of those decisions, Koqentra stores whether you
            agreed, rewrote it, or turned it down — along with your edited text
            when you rewrote it, and a reason when you gave one. The post the AI
            originally proposed is kept as it was written.
          </p>
        </>
      ),
    },
    creatorDoesNot: {
      title: "What Creator does not do",
      body: (
        <>
          <p>
            <strong>Koqentra does not post anything anywhere.</strong> It is not
            connected to X, Reddit, or any publishing service, and nothing it
            writes leaves Koqentra unless you copy it out yourself.
          </p>
          <p>
            What an AI writes may be wrong, and it may be wrong confidently.
            Read it before you publish it.
          </p>
        </>
      ),
    },
    storage: {
      title: "Where it is stored",
      body: (
        <p>
          In a PostgreSQL database hosted on Railway, which also hosts the
          application. Every time Koqentra stores is stored in UTC; a timezone
          changes how a time reads, never what is kept.
        </p>
      ),
    },
    run: {
      title: "What a run records",
      body: (
        <p>
          Each run stores when it started, when it finished, whether it completed
          or failed, what the model produced, and — when it failed — the reason
          the failure carried.
        </p>
      ),
    },
    logs: {
      title: "Logs and diagnostics",
      body: (
        <p>
          When a run fails, details of the failure are written to the
          application&rsquo;s server logs so that it can be looked into. Those
          logs are part of the hosting platform rather than of Koqentra.
        </p>
      ),
    },
    retention: {
      title: "Retention",
      body: (
        <>
          <p>
            Run history is kept until you delete the worker it belongs to.
            Koqentra does not expire it, and there is no period after which it is
            removed automatically.
          </p>
          <p>
            The same is true of everything Creator stores — what you submitted,
            the decisions, the post text, and your answers.{" "}
            <strong>
              There is currently no way to delete it from inside Koqentra
            </strong>
            , and nothing removes it after a period of time. Deleting a worker
            does not touch it: the two are separate, and a worker knows nothing
            about it.
          </p>
        </>
      ),
    },
    deleteWorker: {
      title: "Deleting a worker",
      body: (
        <>
          <p>
            Deleting a worker also deletes every run recorded for it. This cannot
            be undone, and there is no archive to restore from.
          </p>
          <p>
            It does not delete anything from Creator. Those are kept under your
            account rather than under any worker.
          </p>
        </>
      ),
    },
    deleteAccount: {
      title: "Deleting your account",
      body: (
        <p>
          There is currently no way to delete your whole account from within
          Koqentra. Deleting each of your workers removes those workers and their
          run history. It does not remove anything Creator holds, and there is no
          in-product way to remove that.
        </p>
      ),
    },
    availability: {
      title: "Availability",
      body: (
        <p>
          Koqentra is in Closed Beta. Its availability and continuity are not
          guaranteed, and scheduled runs may be missed.
        </p>
      ),
    },
    aiOutput: {
      title: "About AI output",
      body: (
        <p>
          What a worker produces comes from an AI model and may be wrong. Please
          do not rely on it as the only basis for an important decision.
        </p>
      ),
    },
    contact: {
      title: "Contact",
      body: (
        <p>
          Questions about this notice, or about what Koqentra holds for your
          account, can be sent to us by email. If you are signed in, the same
          address is under <strong>Settings</strong>.
        </p>
      ),
    },
    changes: {
      title: "Changes to this notice",
      body: (
        <p>
          This notice describes Koqentra as it currently works. It may be updated
          as Koqentra changes.
        </p>
      ),
    },
    back: "Back to Koqentra",
  },
  ja: {
    heading: "プライバシー",
    intro:
      "Koqentraが受け取るもの、それをどこに保管するのか、そして何に使うのかを説明します。",
    closedBeta: {
      title: "Koqentraはクローズドベータです",
      body: (
        <p>
          利用は招待制です。本サービスは運用段階ではなく試用段階にあり、予告なく変更または終了することがあります。
        </p>
      ),
    },
    signIn: {
      title: "サインイン時に受け取るもの",
      body: (
        <p>
          サインインはGoogleを通じて行われます。Koqentraは、Googleが発行するアカウント識別子、メールアドレス、氏名、プロフィール画像のURLを受け取ります。利用者が作成したものはすべて、この識別子のもとに保存されます。
        </p>
      ),
    },
    provide: {
      title: "利用者が入力するもの",
      body: (
        <p>
          ワーカーは、名前、任意の説明、プロンプトで構成されます。アカウントのタイムゾーンも選択でき、これは時刻の表示方法と、スケジュール実行のタイミングの両方を決めます。
        </p>
      ),
    },
    use: {
      title: "利用目的",
      body: (
        <p>
          ワーカーを実行するため、スケジュール実行の次回予定を算出するため、そして結果を表示するために使用します。Koqentraはこれらの情報をこうした機能の提供のために使用し、販売しません。
        </p>
      ),
    },
    ai: {
      title: "AIによる処理",
      body: (
        <p>
          ワーカーを実行すると、そのプロンプト全体が（<code>{"{{today}}"}</code>
          と<code>{"{{now}}"}</code>
          を展開したうえで）Anthropicへ送信され、結果が生成されます。Koqentraは再試行を行いません。失敗したリクエストは失敗として記録され、そのワーカーは次の実行機会を待ちます。
        </p>
      ),
    },
    email: {
      title: "メール通知",
      body: (
        <p>
          メール通知は、利用者が有効にしない限りオフです。有効化はワーカーごとに行います。有効なワーカーの実行が完了または失敗すると、Koqentraはアカウントに登録されたアドレス宛にのみメッセージを送信します（それ以外のアドレスへ送ることはありません）。送信はResendを経由し、Resendは利用者のアドレス、ワーカー名、および実行結果の先頭2,000文字までを受け取ります。失敗した実行に関するメッセージには、失敗の詳細は含まれません。
        </p>
      ),
    },
    creator: {
      title: "文章の分析",
      body: (
        <>
          <p>
            Koqentraに文章の分析を依頼すると、入力したタイトルと本文がAnthropicへ送信されます。Anthropicは、X、Reddit、長文記事のそれぞれについて投稿する価値があるかを個別に判断し、価値があると判断した場合は投稿文を作成します。
          </p>
          <p>
            このリクエストには、Koqentraに登録したオーディエンス・目標・文体の指示に加えて、過去の分析に対する直近の回答も一緒に送られます。送られるのは
            <strong>最大で直近12件</strong>
            であり、全履歴ではありません。それぞれの回答には、AIが示した理由、AIが提案した投稿文、利用者が編集した場合はその文章、利用者が理由を入力した場合はその理由、および対象だったコンテンツの短い抜粋が含まれることがあります。
          </p>
          <p>
            分析が成功すると、Koqentraは、入力されたタイトルと本文、3つのチャネルそれぞれの判断、各判断の理由、および投稿が推奨されたチャネルの投稿文を保存します。
          </p>
          <p>
            それらの判断に回答すると、Koqentraは、採用したか、書き直したか、却下したかを保存します。書き直した場合は編集した文章を、理由を入力した場合はその理由もあわせて保存します。AIが最初に提案した投稿文は、書かれたまま保持され、上書きされません。
          </p>
        </>
      ),
    },
    creatorDoesNot: {
      title: "Creatorが行わないこと",
      body: (
        <>
          <p>
            <strong>Koqentraはどこにも自動投稿しません。</strong>
            X、Reddit、その他の公開サービスと接続しておらず、Koqentraが書いた文章は、利用者自身がコピーして持ち出さない限りKoqentraの外へ出ることはありません。
          </p>
          <p>
            AIが書いた内容は誤っていることがあり、しかも自信ありげに誤っていることがあります。公開する前に必ず確認してください。
          </p>
        </>
      ),
    },
    storage: {
      title: "保管場所",
      body: (
        <p>
          アプリケーションと同じくRailway上でホストされているPostgreSQLデータベースに保管されます。Koqentraが保存する時刻はすべてUTCです。タイムゾーンは時刻の見え方を変えるだけで、保存される内容そのものを変えることはありません。
        </p>
      ),
    },
    run: {
      title: "実行が記録するもの",
      body: (
        <p>
          各実行について、開始時刻、終了時刻、完了したか失敗したか、モデルが生成した内容、そして失敗した場合はその失敗が伴っていた理由を保存します。
        </p>
      ),
    },
    logs: {
      title: "ログと診断情報",
      body: (
        <p>
          実行が失敗した場合、調査できるように失敗の詳細がアプリケーションのサーバーログへ書き出されます。これらのログはKoqentraではなく、ホスティングプラットフォーム側のものです。
        </p>
      ),
    },
    retention: {
      title: "保存期間",
      body: (
        <>
          <p>
            実行履歴は、それが属するワーカーを削除するまで保持されます。Koqentraが期限切れにすることはなく、一定期間が過ぎたら自動的に削除される仕組みもありません。
          </p>
          <p>
            Creatorが保存するもの（入力した内容、判断、投稿文、利用者の回答）についても同じです。
            <strong>
              現在、Koqentraの中からこれらを削除する手段はありません
            </strong>
            。また、一定期間の経過によって削除されることもありません。ワーカーを削除してもこれらには影響しません。両者は別のものであり、ワーカーはこれらについて何も関知しません。
          </p>
        </>
      ),
    },
    deleteWorker: {
      title: "ワーカーの削除",
      body: (
        <>
          <p>
            ワーカーを削除すると、そのワーカーに記録されたすべての実行も削除されます。これは取り消せず、復元できるアーカイブもありません。
          </p>
          <p>
            ワーカーを削除しても、Creatorのデータは何も削除されません。これらはワーカーではなくアカウントに紐づいて保持されます。
          </p>
        </>
      ),
    },
    deleteAccount: {
      title: "アカウントの削除",
      body: (
        <p>
          現在、Koqentraの中からアカウント全体を削除する手段はありません。ワーカーを一つずつ削除すれば、それらのワーカーと実行履歴は削除されます。ただしCreatorが保持しているものは削除されず、それを製品内から削除する方法もありません。
        </p>
      ),
    },
    availability: {
      title: "可用性",
      body: (
        <p>
          Koqentraはクローズドベータです。可用性および継続性は保証されず、スケジュール実行が行われないことがあります。
        </p>
      ),
    },
    aiOutput: {
      title: "AIの出力について",
      body: (
        <p>
          ワーカーが生成する内容はAIモデルによるものであり、誤っていることがあります。重要な判断の唯一の根拠として利用しないでください。
        </p>
      ),
    },
    contact: {
      title: "お問い合わせ",
      body: (
        <p>
          本ノーティスについて、またはお使いのアカウントについてKoqentraが保持している内容について、メールでお問い合わせいただけます。サインイン済みの場合は、
          <strong>設定</strong>にも同じアドレスを掲載しています。
        </p>
      ),
    },
    changes: {
      title: "本ノーティスの変更",
      body: (
        <p>
          本ノーティスは現時点のKoqentraの動作を説明したものです。Koqentraの変更にあわせて更新されることがあります。
        </p>
      ),
    },
    back: "Koqentraに戻る",
  },
} satisfies Record<Language, PrivacyCopy>;

/**
 * **Rendered per request, because the contact section is configuration.**
 * This page used to be prerendered, which was right while every word of it was
 * a constant. It now reads `SUPPORT_EMAIL`, and a page baked at build time
 * would answer with whatever the build environment happened to hold — most
 * likely nothing — and keep answering that after the variable was set. It now
 * also reads the account language, which is per-request for the same reason.
 */
export const dynamic = "force-dynamic";

export default async function PrivacyPage() {
  /**
   * **An optional session, never a required one.** A privacy notice a
   * signed-out visitor cannot open is not much of a privacy notice, so this
   * asks `auth()` rather than `requireUserId()` — which redirects — and reads
   * the stored language only when there is a trusted id to read it for.
   *
   * **Reading is all it does.** `getUserLanguage` falls back to English for a
   * row that does not exist rather than writing one, so opening this page
   * provisions no account: the same ordering C1.4R settled for Creator.
   */
  const session = await auth();
  const userId = session?.user?.id;
  const language = userId ? await getUserLanguage(userId) : DEFAULT_LANGUAGE;

  const copy = PRIVACY_COPY[language];
  const supportHref = supportMailtoHref(
    t(language, "settings.support.subject"),
  );

  return (
    <div className="flex flex-1 flex-col bg-background">
      <header className="mx-auto flex w-full max-w-6xl items-center px-6 py-6 sm:px-10">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Koqentra
        </Link>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-10 sm:px-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {copy.heading}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">{copy.intro}</p>

        <Section title={copy.closedBeta.title}>{copy.closedBeta.body}</Section>
        <Section title={copy.signIn.title}>{copy.signIn.body}</Section>
        <Section title={copy.provide.title}>{copy.provide.body}</Section>
        <Section title={copy.use.title}>{copy.use.body}</Section>
        <Section title={copy.ai.title}>{copy.ai.body}</Section>
        <Section title={copy.email.title}>{copy.email.body}</Section>

        {/* **Creator is a second thing Koqentra sends to a model, and it sends
            something different.** A worker sends instructions somebody wrote to
            be sent; Creator sends a piece of writing that has not been
            published. Describing the first and not the second would leave this
            page accurate about the smaller half. */}
        <Section title={copy.creator.title}>{copy.creator.body}</Section>
        <Section title={copy.creatorDoesNot.title}>
          {copy.creatorDoesNot.body}
        </Section>

        <Section title={copy.storage.title}>{copy.storage.body}</Section>
        <Section title={copy.run.title}>{copy.run.body}</Section>
        <Section title={copy.logs.title}>{copy.logs.body}</Section>
        <Section title={copy.retention.title}>{copy.retention.body}</Section>
        <Section title={copy.deleteWorker.title}>
          {copy.deleteWorker.body}
        </Section>
        <Section title={copy.deleteAccount.title}>
          {copy.deleteAccount.body}
        </Section>
        <Section title={copy.availability.title}>
          {copy.availability.body}
        </Section>
        <Section title={copy.aiOutput.title}>{copy.aiOutput.body}</Section>

        {/* **The way to reach a person without signing in.** Settings carries
            the same link for somebody who is already inside; this page is
            public, and a privacy notice that can only be asked about by people
            with accounts is not much of one.

            **The address comes from the same single source** — `lib/support.ts`
            reading `SUPPORT_EMAIL` — and is never written here. With none
            configured there is no section, exactly as on Settings: no reader is
            shown a link that goes nowhere. */}
        {supportHref ? (
          <Section title={copy.contact.title}>
            {copy.contact.body}
            <p>
              <a href={supportHref} className="underline underline-offset-4">
                {t(language, "settings.support.action")}
              </a>
            </p>
          </Section>
        ) : null}

        <Section title={copy.changes.title}>{copy.changes.body}</Section>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-6 py-8 text-center text-sm text-muted-foreground sm:px-10">
        <Link href="/" className="underline-offset-4 hover:underline">
          {copy.back}
        </Link>
      </footer>
    </div>
  );
}
