import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import {
  LegalLanguageSwitch,
  type LegalSearchParams,
  requestedLegalLanguage,
} from "@/components/legal-language-switch";
import { MONTHLY_YEN } from "@/lib/billing/pricing";
import { DEFAULT_LANGUAGE, t, type Language } from "@/lib/i18n";
import { getDocumentLanguage } from "@/lib/i18n/server";
import { getPlanDefinition } from "@/lib/plans";
import { supportMailtoHref } from "@/lib/support";
import { getUserLanguage } from "@/lib/users";

/**
 * The seller's notice required for selling the paid plans (特定商取引法に基づく表記).
 *
 * **Japanese is the authoritative text**; the English states the same facts.
 * Both are page-local, like `/privacy`: a legal notice is not a set of interface
 * strings, and moving it into the shared dictionary would grow a file every
 * screen imports for one route.
 *
 * **The numbers are read, not restated.** Prices come from the catalogue the
 * Plans page shows, and the trial's limits from `lib/plans.ts`, so this page
 * cannot quote a price or a limit the product no longer has.
 *
 * **The contact is the one `SUPPORT_EMAIL` configures**, through
 * `lib/support.ts`, never written here.
 */

const TRIAL = getPlanDefinition("trial");

function yen(amount: number): string {
  return amount.toLocaleString("en-US");
}

type Row = { label: string; value: React.ReactNode };

type LegalCopy = {
  heading: string;
  intro: string;
  metadataDescription: string;
  service: Row;
  seller: Row;
  manager: Row;
  address: Row;
  phone: Row;
  disclosure: string;
  contactLabel: string;
  contactAction: string;
  contactMissing: string;
  price: Row;
  otherCosts: Row;
  payment: Row;
  paymentTiming: Row;
  delivery: Row;
  term: Row;
  cancellation: Row;
  afterCancellation: Row;
  refunds: Row;
  trial: Row;
  environment: Row;
  back: string;
};

const LEGAL_COPY = {
  ja: {
    heading: "特定商取引法に基づく表記",
    intro: "Koqentra の有料プランの販売に関する表示です。",
    metadataDescription:
      "Koqentra の販売事業者、販売価格、支払方法、解約、返金などに関する表示です。",
    service: { label: "サービス名", value: "Koqentra" },
    seller: { label: "販売事業者名", value: "請求があれば遅滞なく開示します。" },
    manager: { label: "運営責任者", value: "請求があれば遅滞なく開示します。" },
    address: { label: "所在地", value: "請求があれば遅滞なく開示します。" },
    phone: { label: "電話番号", value: "請求があれば遅滞なく開示します。" },
    disclosure:
      "販売事業者名、運営責任者、所在地、電話番号については、請求があれば遅滞なく開示します。開示請求は下記の問い合わせ先までご連絡ください。",
    contactLabel: "お問い合わせ・開示請求",
    contactAction: "メールで問い合わせる",
    contactMissing: "現在、問い合わせ先を準備中です。",
    price: {
      label: "販売価格",
      value: (
        <ul className="list-disc pl-5">
          <li>Lite: 月額 {yen(MONTHLY_YEN.lite)}円</li>
          <li>Standard: 月額 {yen(MONTHLY_YEN.standard)}円</li>
          <li>Pro: 月額 {yen(MONTHLY_YEN.pro)}円</li>
        </ul>
      ),
    },
    otherCosts: {
      label: "販売価格以外の負担",
      value:
        "インターネット接続料金、通信料金その他、利用者側で発生する費用。",
    },
    payment: {
      label: "支払方法",
      value: "Stripe Checkout 上で利用可能として表示される決済方法。",
    },
    paymentTiming: {
      label: "支払時期",
      value: (
        <ul className="list-disc pl-5">
          <li>初回: 有料プランの開始時</li>
          <li>以後: 契約開始日を基準に1か月ごとに自動更新</li>
        </ul>
      ),
    },
    delivery: {
      label: "サービス提供時期",
      value: "決済が正常に反映された後、ご利用いただけます。",
    },
    term: { label: "契約期間", value: "月単位の継続契約です。" },
    cancellation: {
      label: "解約",
      value: "Stripe Billing Portal から解約できます。",
    },
    afterCancellation: {
      label: "解約後の利用",
      value: "解約後も、現在の請求期間の終了までは利用できます。",
    },
    refunds: {
      label: "返金",
      value:
        "原則として返金は行いません。ただし、重複請求、明らかな決済上の誤り、法令上返金が必要となる場合その他当方が必要と判断した場合は、個別に対応します。",
    },
    trial: {
      label: "トライアル",
      value: (
        <>
          <p>
            対象となる利用者に、{TRIAL.trialDurationDays}
            日間のトライアルを提供します。トライアルは Lite と同一ではなく、独立したプランです。
          </p>
          <ul className="mt-2 list-disc pl-5">
            <li>同時に稼働できるWorker数: {TRIAL.activeWorkerLimit}</li>
            <li>AI処理: {TRIAL.aiProcessingLimit}</li>
            <li>手動実行: {TRIAL.manualRunLimit}</li>
            <li>おすすめ探し: {TRIAL.discoveryLimit}</li>
          </ul>
          <p className="mt-2">
            トライアル期間中に有料プランを開始した場合、その時点でトライアルは終了し、残りのトライアル期間は持ち越されません。有料プランの利用枠は 0 から開始します。
          </p>
        </>
      ),
    },
    environment: {
      label: "動作環境",
      value: "インターネット接続および対応する Web ブラウザが必要です。",
    },
    back: "Koqentraに戻る",
  },
  en: {
    heading: "Legal notice (Specified Commercial Transactions Act)",
    intro:
      "Disclosures for the sale of Koqentra's paid plans. The Japanese version is the authoritative text.",
    metadataDescription:
      "Koqentra's seller, prices, payment, cancellation and refund disclosures.",
    service: { label: "Service name", value: "Koqentra" },
    seller: { label: "Seller", value: "Disclosed without delay upon request." },
    manager: {
      label: "Person responsible",
      value: "Disclosed without delay upon request.",
    },
    address: { label: "Address", value: "Disclosed without delay upon request." },
    phone: {
      label: "Phone number",
      value: "Disclosed without delay upon request.",
    },
    disclosure:
      "The seller's name, the person responsible, the address and the phone number are disclosed without delay upon request. Please send a disclosure request to the contact below.",
    contactLabel: "Contact and disclosure requests",
    contactAction: "Contact us by email",
    contactMissing: "A contact address is being prepared.",
    price: {
      label: "Prices",
      value: (
        <ul className="list-disc pl-5">
          <li>Lite: ¥{yen(MONTHLY_YEN.lite)} per month</li>
          <li>Standard: ¥{yen(MONTHLY_YEN.standard)} per month</li>
          <li>Pro: ¥{yen(MONTHLY_YEN.pro)} per month</li>
        </ul>
      ),
    },
    otherCosts: {
      label: "Costs other than the price",
      value:
        "Internet connection and data charges, and any other costs incurred on the user's side.",
    },
    payment: {
      label: "Payment methods",
      value: "The payment methods shown as available on Stripe Checkout.",
    },
    paymentTiming: {
      label: "When payment is taken",
      value: (
        <ul className="list-disc pl-5">
          <li>First payment: when the paid plan starts</li>
          <li>
            After that: renewed automatically every month, counted from the date
            the subscription started
          </li>
        </ul>
      ),
    },
    delivery: {
      label: "When the service is provided",
      value: "Once the payment has been successfully applied.",
    },
    term: { label: "Contract term", value: "A monthly, continuing subscription." },
    cancellation: {
      label: "Cancellation",
      value: "You can cancel from the Stripe Billing Portal.",
    },
    afterCancellation: {
      label: "After cancellation",
      value:
        "You can keep using the plan until the end of the current billing period.",
    },
    refunds: {
      label: "Refunds",
      value:
        "As a rule, payments are not refunded. Duplicate charges, clear payment errors, cases where a refund is required by law, and other cases we judge necessary are handled individually.",
    },
    trial: {
      label: "Trial",
      value: (
        <>
          <p>
            Eligible users are offered a {TRIAL.trialDurationDays}-day trial. The
            trial is a plan of its own, not the same as Lite.
          </p>
          <ul className="mt-2 list-disc pl-5">
            <li>Workers active at once: {TRIAL.activeWorkerLimit}</li>
            <li>AI processing: {TRIAL.aiProcessingLimit}</li>
            <li>Manual runs: {TRIAL.manualRunLimit}</li>
            <li>Recommendation runs: {TRIAL.discoveryLimit}</li>
          </ul>
          <p className="mt-2">
            Starting a paid plan during the trial ends the trial at that point.
            The remaining trial days are not carried over, and the paid plan&rsquo;s
            allowance starts from zero.
          </p>
        </>
      ),
    },
    environment: {
      label: "System requirements",
      value: "An internet connection and a supported web browser.",
    },
    back: "Back to Koqentra",
  },
} satisfies Record<Language, LegalCopy>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams?: LegalSearchParams;
}): Promise<Metadata> {
  const copy =
    LEGAL_COPY[
      (await requestedLegalLanguage(searchParams)) ?? (await getDocumentLanguage())
    ];

  return {
    title: `${copy.heading} — Koqentra`,
    description: copy.metadataDescription,
  };
}

/** Rendered per request: the contact is configuration, and so is the language. */
export const dynamic = "force-dynamic";

function Field({ row }: { row: Row }) {
  return (
    <div className="border-t border-border py-4 sm:grid sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm font-medium">{row.label}</dt>
      <dd className="mt-1 text-sm leading-relaxed text-muted-foreground sm:col-span-2 sm:mt-0">
        {row.value}
      </dd>
    </div>
  );
}

export default async function LegalPage({
  searchParams,
}: {
  searchParams?: LegalSearchParams;
}) {
  // An optional session, never a required one: this notice is public.
  const session = await auth();
  const userId = session?.user?.id;
  // `?lang=` first, so a visitor with no session can still read either
  // language; then the account's own; then the default.
  const language =
    (await requestedLegalLanguage(searchParams)) ??
    (userId ? await getUserLanguage(userId) : DEFAULT_LANGUAGE);

  const copy = LEGAL_COPY[language];
  const supportHref = supportMailtoHref(t(language, "settings.support.subject"));

  return (
    <div className="flex flex-1 flex-col bg-background">
      <header className="mx-auto flex w-full max-w-6xl items-center px-6 py-6 sm:px-10">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Koqentra
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10 sm:px-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {copy.heading}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">{copy.intro}</p>
        <LegalLanguageSwitch path="/legal" language={language} />

        <dl className="mt-8 border-b border-border">
          <Field row={copy.service} />
          <Field row={copy.seller} />
          <Field row={copy.manager} />
          <Field row={copy.address} />
          <Field row={copy.phone} />
          <Field
            row={{
              label: copy.contactLabel,
              value: (
                <>
                  <p>{copy.disclosure}</p>
                  <p className="mt-2">
                    {supportHref ? (
                      <a href={supportHref} className="underline underline-offset-4">
                        {copy.contactAction}
                      </a>
                    ) : (
                      copy.contactMissing
                    )}
                  </p>
                </>
              ),
            }}
          />
          <Field row={copy.price} />
          <Field row={copy.otherCosts} />
          <Field row={copy.payment} />
          <Field row={copy.paymentTiming} />
          <Field row={copy.delivery} />
          <Field row={copy.term} />
          <Field row={copy.cancellation} />
          <Field row={copy.afterCancellation} />
          <Field row={copy.refunds} />
          <Field row={copy.trial} />
          <Field row={copy.environment} />
        </dl>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-6 py-8 text-center text-sm text-muted-foreground sm:px-10">
        <Link href="/" className="underline-offset-4 hover:underline">
          {copy.back}
        </Link>
      </footer>
    </div>
  );
}
