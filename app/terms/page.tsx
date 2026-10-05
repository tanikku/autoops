import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import {
  LegalLanguageSwitch,
  type LegalSearchParams,
  requestedLegalLanguage,
} from "@/components/legal-language-switch";
import { DEFAULT_LANGUAGE, t, type Language } from "@/lib/i18n";
import { getDocumentLanguage } from "@/lib/i18n/server";
import { getPlanDefinition } from "@/lib/plans";
import { supportMailtoHref } from "@/lib/support";
import { getUserLanguage } from "@/lib/users";

/**
 * Koqentra's terms of service.
 *
 * **Japanese is the authoritative text**; the English states the same terms.
 * Page-local, like `/privacy` and `/legal`.
 *
 * **Each plan's limits are not restated** — Plans shows them and is kept in step
 * with the catalogue. The trial's are, because the trial's rules are part of
 * these terms; they are read from `lib/plans.ts` rather than typed here.
 */

const TRIAL = getPlanDefinition("trial");

type Passage = { title: string; body: React.ReactNode };

type TermsCopy = {
  heading: string;
  intro: string;
  metadataDescription: string;
  sections: readonly Passage[];
  contactTitle: string;
  contactBody: string;
  contactAction: string;
  contactMissing: string;
  back: string;
};

const TERMS_COPY = {
  ja: {
    heading: "利用規約",
    intro:
      "この利用規約（以下「本規約」）は、Koqentra（以下「本サービス」）の利用条件を定めるものです。",
    metadataDescription:
      "Koqentra の利用条件、トライアル、有料プラン、解約、返金、免責などを定めた利用規約です。",
    sections: [
      {
        title: "1. 適用",
        body: (
          <p>
            本規約は、本サービスを利用するすべての利用者に適用されます。利用者は、本規約に同意したうえで本サービスを利用するものとします。
          </p>
        ),
      },
      {
        title: "2. アカウント",
        body: (
          <p>
            本サービスへのサインインには Google アカウントによる認証を利用します。利用者は、自身のアカウントを適切に管理し、第三者に利用させないものとします。
          </p>
        ),
      },
      {
        title: "3. サービス内容",
        body: (
          <p>
            本サービスは、利用者が設定した Worker（AI への依頼、Web ページの監視、YouTubeでのおすすめ動画探し等）の実行、文章の分析（Creator）その他の機能を提供します。外部の Web サイトの内容、可用性、変更、アクセス制限等により、期待する結果にならない場合があります。YouTubeおすすめ探し等の結果の内容は保証しません。
          </p>
        ),
      },
      {
        title: "4. AI機能と出力",
        body: (
          <p>
            本サービスは、AI による生成・要約・分析等に Anthropic の Claude API を利用します。AI の出力について、正確性、完全性、特定の目的への適合性は保証しません。出力の最終的な確認と判断は、利用者自身が行うものとします。
          </p>
        ),
      },
      {
        title: "5. ユーザー入力・処理対象",
        body: (
          <p>
            利用者は、入力する内容および処理対象として指定する Web ページ等について、必要な権利または許諾を有するものとします。本サービスは、利用者が入力した内容を、本サービスの提供に必要な範囲で保存・処理します。
          </p>
        ),
      },
      {
        title: "6. 禁止事項",
        body: (
          <>
            <p>利用者は、本サービスの利用にあたり、次の行為をしてはなりません。</p>
            <ul className="list-disc pl-5">
              <li>法令に違反する行為</li>
              <li>第三者の権利を侵害する行為</li>
              <li>本サービスまたは第三者のシステムへの不正アクセス</li>
              <li>本サービスの運営を妨害する行為</li>
              <li>本サービスを利用した過度な自動アクセス</li>
              <li>他人の認証情報の不正な利用</li>
              <li>本サービスの運営者または第三者に不利益を与える行為</li>
              <li>その他、本サービスの運営上不適切であると合理的に判断される行為</li>
            </ul>
          </>
        ),
      },
      {
        title: "7. 利用枠・レート制限",
        body: (
          <p>
            本サービスには、プランごとに「同時に稼働できるWorker数」「AI処理」「手動実行」「YouTubeおすすめ探し」の利用枠と、一定時間あたりの利用回数の制限（レート制限）があります。各プランの利用枠は Plans に表示します。利用枠またはレート制限の上限に達した場合、該当する機能の利用は制限されます。
          </p>
        ),
      },
      {
        title: "8. トライアル",
        body: (
          <>
            <p>
              本サービスは、対象となる利用者に {TRIAL.trialDurationDays}
              日間のトライアルを提供することがあります。トライアルを提供するかどうかは、本サービスが定める条件によります。トライアルは Lite と同一ではなく、独立したプランです。トライアルの利用枠は、同時に稼働できるWorker数 {TRIAL.activeWorkerLimit}、AI処理 {TRIAL.aiProcessingLimit}、手動実行 {TRIAL.manualRunLimit}、YouTubeおすすめ探し {TRIAL.discoveryLimit} です。
            </p>
            <p>
              トライアル期間中に有料プランを開始した場合、その時点でトライアルは終了し、残りのトライアル期間は持ち越されません。有料プランの利用枠は 0 から開始します。
            </p>
          </>
        ),
      },
      {
        title: "9. 有料プラン・自動更新",
        body: (
          <p>
            有料プランは月単位の継続契約で、契約開始日を基準に1か月ごとに自動更新されます。決済には Stripe を利用します。価格は Plans および特定商取引法に基づく表記に表示します。
          </p>
        ),
      },
      {
        title: "10. 解約",
        body: (
          <p>
            利用者は、Stripe Billing Portal から有料プランを解約できます。解約は次回以降の更新を停止するもので、解約後も現在の請求期間の終了までは有料プランを利用できます。
          </p>
        ),
      },
      {
        title: "11. 返金",
        body: (
          <p>
            原則として返金は行いません。ただし、重複請求、明らかな決済上の誤り、法令上返金が必要となる場合その他当方が必要と判断した場合は、個別に対応します。
          </p>
        ),
      },
      {
        title: "12. サービスの変更・停止",
        body: (
          <p>
            本サービスは、保守、障害、外部サービスの状況、不可抗力その他の理由により、本サービスの全部または一部を変更し、または一時的に停止する場合があります。
          </p>
        ),
      },
      {
        title: "13. 知的財産",
        body: (
          <p>
            本サービスに関する権利は、本サービスの運営者に帰属します。利用者が入力したコンテンツの権利は利用者に留まり、本サービスは、本サービスの提供に必要な範囲でのみこれを利用します。
          </p>
        ),
      },
      {
        title: "14. 免責",
        body: (
          <p>
            本サービスは、AI の出力、外部の Web サイトや外部サービスの内容・可用性、およびそれらに基づいて利用者が行った判断について、明示または黙示を問わず保証しません。
          </p>
        ),
      },
      {
        title: "15. 責任の制限",
        body: (
          <p>
            本サービスの運営者が利用者に対して負う責任は、法令の定める範囲に限られます。
          </p>
        ),
      },
      {
        title: "16. アカウント停止・利用制限",
        body: (
          <p>
            利用者が本規約に違反した場合その他本サービスの運営上必要があると合理的に判断した場合、本サービスは、利用者のアカウントの停止または利用の制限を行うことがあります。
          </p>
        ),
      },
      {
        title: "17. 規約変更",
        body: (
          <p>
            本サービスは、必要に応じて本規約を変更することがあります。重要な変更を行う場合は、本サービス上での掲示その他適切な方法で周知します。
          </p>
        ),
      },
      {
        title: "18. 準拠法・紛争解決",
        body: (
          <p>
            本規約は日本法を準拠法とします。本サービスに関して紛争が生じた場合は、適用される法令に従って解決するものとします。
          </p>
        ),
      },
    ],
    contactTitle: "19. 問い合わせ",
    contactBody: "本規約および本サービスに関するお問い合わせは、以下までご連絡ください。",
    contactAction: "メールで問い合わせる",
    contactMissing: "現在、問い合わせ先を準備中です。",
    back: "Koqentraに戻る",
  },
  en: {
    heading: "Terms of Service",
    intro:
      "These Terms of Service (the “Terms”) set out the conditions for using Koqentra (the “Service”). The Japanese version is the authoritative text.",
    metadataDescription:
      "The terms for using Koqentra: trial, paid plans, cancellation, refunds and disclaimers.",
    sections: [
      {
        title: "1. Scope",
        body: (
          <p>
            These Terms apply to everyone who uses the Service. By using the
            Service, you agree to these Terms.
          </p>
        ),
      },
      {
        title: "2. Accounts",
        body: (
          <p>
            Signing in to the Service uses your Google account. You are
            responsible for keeping your account secure and must not let anyone
            else use it.
          </p>
        ),
      },
      {
        title: "3. The Service",
        body: (
          <p>
            The Service runs the workers you set up (asking an AI, watching a
            web page, finding recommended videos on YouTube and so on), analyzes
            writing
            (Creator), and provides related features. The content, availability
            and changes of external websites, and any access restrictions they
            apply, may mean a result is not what you expected. The results of
            YouTube recommendation searches and similar features are not
            guaranteed.
          </p>
        ),
      },
      {
        title: "4. AI features and output",
        body: (
          <p>
            The Service uses Anthropic&rsquo;s Claude API for AI generation,
            summarization and analysis. AI output is not guaranteed to be
            accurate, complete or fit for any particular purpose. You are
            responsible for checking it and for the decisions you make with it.
          </p>
        ),
      },
      {
        title: "5. What you provide",
        body: (
          <p>
            You must have the rights or permissions needed for what you enter
            and for the web pages and other targets you ask the Service to
            process. The Service stores and processes what you enter only as
            needed to provide the Service.
          </p>
        ),
      },
      {
        title: "6. Prohibited use",
        body: (
          <>
            <p>When using the Service, you must not:</p>
            <ul className="list-disc pl-5">
              <li>break the law;</li>
              <li>infringe anyone else&rsquo;s rights;</li>
              <li>gain unauthorized access to the Service or anyone else&rsquo;s systems;</li>
              <li>interfere with the operation of the Service;</li>
              <li>use the Service for excessive automated access;</li>
              <li>misuse anyone else&rsquo;s credentials;</li>
              <li>act in a way that harms the operator of the Service or anyone else; or</li>
              <li>do anything else reasonably judged inappropriate for the operation of the Service.</li>
            </ul>
          </>
        ),
      },
      {
        title: "7. Allowances and rate limits",
        body: (
          <p>
            Each plan comes with allowances for &ldquo;Workers active at
            once&rdquo;, &ldquo;AI processing&rdquo;, &ldquo;Manual runs&rdquo;
            and &ldquo;YouTube recommendation runs&rdquo;, and with limits on how
            often
            some features can be used in a given time (rate limits). Each
            plan&rsquo;s allowances are shown on Plans. When an allowance or rate
            limit is reached, use of the feature concerned is restricted.
          </p>
        ),
      },
      {
        title: "8. Trial",
        body: (
          <>
            <p>
              The Service may offer eligible users a {TRIAL.trialDurationDays}-day
              trial, on the conditions the Service sets. The trial is a plan of
              its own, not the same as Lite. Its allowances are: Workers active at
              once {TRIAL.activeWorkerLimit}, AI processing{" "}
              {TRIAL.aiProcessingLimit}, Manual runs {TRIAL.manualRunLimit}, and
              YouTube recommendation runs {TRIAL.discoveryLimit}.
            </p>
            <p>
              Starting a paid plan during the trial ends the trial at that point.
              The remaining trial days are not carried over, and the paid
              plan&rsquo;s allowance starts from zero.
            </p>
          </>
        ),
      },
      {
        title: "9. Paid plans and automatic renewal",
        body: (
          <p>
            Paid plans are monthly, continuing subscriptions, renewed
            automatically every month from the date the subscription started.
            Payments are handled by Stripe. Prices are shown on Plans and in the
            legal notice.
          </p>
        ),
      },
      {
        title: "10. Cancellation",
        body: (
          <p>
            You can cancel a paid plan from the Stripe Billing Portal.
            Cancelling stops future renewals; you can keep using the paid plan
            until the end of the current billing period.
          </p>
        ),
      },
      {
        title: "11. Refunds",
        body: (
          <p>
            As a rule, payments are not refunded. Duplicate charges, clear
            payment errors, cases where a refund is required by law, and other
            cases we judge necessary are handled individually.
          </p>
        ),
      },
      {
        title: "12. Changes to and suspension of the Service",
        body: (
          <p>
            The Service may change all or part of itself, or be temporarily
            suspended, for maintenance, because of a fault, because of the state
            of an external service, because of force majeure, or for other
            reasons.
          </p>
        ),
      },
      {
        title: "13. Intellectual property",
        body: (
          <p>
            Rights in the Service belong to its operator. Rights in the content
            you enter stay with you; the Service uses it only as needed to
            provide the Service.
          </p>
        ),
      },
      {
        title: "14. Disclaimer",
        body: (
          <p>
            The Service makes no warranty, express or implied, about AI output,
            about the content or availability of external websites and services,
            or about decisions you make based on them.
          </p>
        ),
      },
      {
        title: "15. Limitation of liability",
        body: (
          <p>
            The operator&rsquo;s liability to you is limited to the extent
            provided by law.
          </p>
        ),
      },
      {
        title: "16. Suspension of accounts and restriction of use",
        body: (
          <p>
            If you breach these Terms, or where it is otherwise reasonably judged
            necessary for operating the Service, the Service may suspend your
            account or restrict your use of the Service.
          </p>
        ),
      },
      {
        title: "17. Changes to these Terms",
        body: (
          <p>
            These Terms may be changed when necessary. Significant changes will
            be announced on the Service or by another appropriate means.
          </p>
        ),
      },
      {
        title: "18. Governing law and dispute resolution",
        body: (
          <p>
            These Terms are governed by the laws of Japan. Any dispute concerning
            the Service will be resolved in accordance with the applicable laws.
          </p>
        ),
      },
    ],
    contactTitle: "19. Contact",
    contactBody: "For questions about these Terms or the Service, please contact us below.",
    contactAction: "Contact us by email",
    contactMissing: "A contact address is being prepared.",
    back: "Back to Koqentra",
  },
} satisfies Record<Language, TermsCopy>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams?: LegalSearchParams;
}): Promise<Metadata> {
  const copy =
    TERMS_COPY[
      (await requestedLegalLanguage(searchParams)) ?? (await getDocumentLanguage())
    ];

  return {
    title: `${copy.heading} — Koqentra`,
    description: copy.metadataDescription,
  };
}

/** Rendered per request: the contact is configuration, and so is the language. */
export const dynamic = "force-dynamic";

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

export default async function TermsPage({
  searchParams,
}: {
  searchParams?: LegalSearchParams;
}) {
  // An optional session, never a required one: these terms are public.
  const session = await auth();
  const userId = session?.user?.id;
  // `?lang=` first, so a visitor with no session can still read either
  // language; then the account's own; then the default.
  const language =
    (await requestedLegalLanguage(searchParams)) ??
    (userId ? await getUserLanguage(userId) : DEFAULT_LANGUAGE);

  const copy = TERMS_COPY[language];
  const supportHref = supportMailtoHref(t(language, "settings.support.subject"));

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
        <LegalLanguageSwitch path="/terms" language={language} />

        {copy.sections.map((section) => (
          <Section key={section.title} title={section.title}>
            {section.body}
          </Section>
        ))}

        <Section title={copy.contactTitle}>
          <p>{copy.contactBody}</p>
          <p>
            {supportHref ? (
              <a href={supportHref} className="underline underline-offset-4">
                {copy.contactAction}
              </a>
            ) : (
              copy.contactMissing
            )}
          </p>
        </Section>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-6 py-8 text-center text-sm text-muted-foreground sm:px-10">
        <Link href="/" className="underline-offset-4 hover:underline">
          {copy.back}
        </Link>
      </footer>
    </div>
  );
}
