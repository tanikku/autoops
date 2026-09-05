import type { Metadata } from "next";
import Link from "next/link";
import { DEFAULT_LANGUAGE, t } from "@/lib/i18n";
import { supportMailtoHref } from "@/lib/support";

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

/**
 * **Rendered per request, because the contact section is configuration.**
 * This page used to be prerendered, which was right while every word of it was
 * a constant. It now reads `SUPPORT_EMAIL`, and a page baked at build time
 * would answer with whatever the build environment happened to hold — most
 * likely nothing — and keep answering that after the variable was set. Nothing
 * else about the page changed.
 */
export const dynamic = "force-dynamic";

export default function PrivacyPage() {
  // This page is written in English rather than translated, so the subject line
  // is read in the default language — the one the page itself is in.
  const supportHref = supportMailtoHref(
    t(DEFAULT_LANGUAGE, "settings.support.subject"),
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
          Privacy
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          What Koqentra receives, where it is kept, and what it does with it.
        </p>

        <Section title="Koqentra is in Closed Beta">
          <p>
            Access is by invitation. The service is being tried out rather than
            operated, and it may change or stop without notice.
          </p>
        </Section>

        <Section title="What we receive when you sign in">
          <p>
            Signing in goes through Google. Koqentra receives the account
            identifier Google issues for you, your email address, your name, and
            the URL of your profile picture. The identifier is what everything
            you create is filed under.
          </p>
        </Section>

        <Section title="What you provide">
          <p>
            A worker is a name, an optional description, and a prompt. You also
            choose a timezone for your account, which decides both how times are
            displayed and when scheduled workers run.
          </p>
        </Section>

        <Section title="How it is used">
          <p>
            To run your workers, to work out when a scheduled one is next due,
            and to show you the result. Nothing is used to build a profile of
            you, and nothing is sold.
          </p>
        </Section>

        <Section title="AI processing">
          <p>
            Running a worker sends its prompt — the whole of it, with{" "}
            <code>{"{{today}}"}</code> and <code>{"{{now}}"}</code> already
            filled in — to Anthropic, which produces the result. Koqentra does not
            retry: a request that fails is recorded as a failure and the worker
            waits for its next turn.
          </p>
        </Section>

        <Section title="Email notifications">
          <p>
            Email notifications are off unless you turn them on, and you turn
            them on for one worker at a time. While one is on, Koqentra sends a
            message to the address on your account — never to any other — when
            that worker&rsquo;s run finishes or fails. Sending goes through
            Resend, which receives your address, the worker&rsquo;s name, and up
            to two thousand characters of what the run produced. A message about
            a failed run carries no detail of the failure.
          </p>
        </Section>

        {/* **Creator is a second thing Koqentra sends to a model, and it sends
            something different.** A worker sends instructions somebody wrote to
            be sent; Creator sends a piece of writing that has not been
            published. Describing the first and not the second would leave this
            page accurate about the smaller half. */}
        <Section title="Analyzing your writing">
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
        </Section>

        <Section title="What Creator does not do">
          <p>
            <strong>Koqentra does not post anything anywhere.</strong> It is not
            connected to X, Reddit, or any publishing service, and nothing it
            writes leaves Koqentra unless you copy it out yourself.
          </p>
          <p>
            What an AI writes may be wrong, and it may be wrong confidently.
            Read it before you publish it.
          </p>
        </Section>

        <Section title="Where it is stored">
          <p>
            In a PostgreSQL database hosted on Railway, which also hosts the
            application. Every time Koqentra stores is stored in UTC; a timezone
            changes how a time reads, never what is kept.
          </p>
        </Section>

        <Section title="What a run records">
          <p>
            Each run stores when it started, when it finished, whether it
            completed or failed, what the model produced, and — when it failed —
            the reason the failure carried.
          </p>
        </Section>

        <Section title="Logs and diagnostics">
          <p>
            When a run fails, details of the failure are written to the
            application&rsquo;s server logs so that it can be looked into. Those
            logs are part of the hosting platform rather than of Koqentra.
          </p>
        </Section>

        <Section title="Retention">
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
        </Section>

        <Section title="Deleting a worker">
          <p>
            Deleting a worker also deletes every run recorded for it. This
            cannot be undone, and there is no archive to restore from.
          </p>
          <p>
            It does not delete anything from Creator. Those are kept under your
            account rather than under any worker.
          </p>
        </Section>

        <Section title="Deleting your account">
          <p>
            There is currently no way to delete your whole account from within
            Koqentra. Deleting each of your workers removes those workers and
            their run history. It does not remove anything Creator holds, and
            there is no in-product way to remove that.
          </p>
        </Section>

        <Section title="Availability">
          <p>
            Koqentra is in Closed Beta. Its availability and continuity are not
            guaranteed, and scheduled runs may be missed.
          </p>
        </Section>

        <Section title="About AI output">
          <p>
            What a worker produces comes from an AI model and may be wrong.
            Please do not rely on it as the only basis for an important
            decision.
          </p>
        </Section>

        {/* **The way to reach a person without signing in.** Settings carries
            the same link for somebody who is already inside; this page is
            public, and a privacy notice that can only be asked about by people
            with accounts is not much of one.

            **The address comes from the same single source** — `lib/support.ts`
            reading `SUPPORT_EMAIL` — and is never written here. With none
            configured there is no section, exactly as on Settings: no reader is
            shown a link that goes nowhere. */}
        {supportHref ? (
          <Section title="Contact">
            <p>
              Questions about this notice, or about what Koqentra holds for your
              account, can be sent to us by email. If you are signed in, the
              same address is under <strong>Settings</strong>.
            </p>
            <p>
              <a href={supportHref} className="underline underline-offset-4">
                {t(DEFAULT_LANGUAGE, "settings.support.action")}
              </a>
            </p>
          </Section>
        ) : null}

        <Section title="Changes to this notice">
          <p>
            This notice describes Koqentra as it currently works. It may be
            updated as Koqentra changes.
          </p>
        </Section>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-6 py-8 text-center text-sm text-muted-foreground sm:px-10">
        <Link href="/" className="underline-offset-4 hover:underline">
          Back to Koqentra
        </Link>
      </footer>
    </div>
  );
}
