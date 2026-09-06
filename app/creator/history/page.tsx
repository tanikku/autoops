import type { Metadata } from "next";
import Link from "next/link";
import { CreatorHistoryDecisionCard } from "@/components/creator-history-decision-card";
import { DashboardNav } from "@/components/dashboard-nav";
import { Button } from "@/components/ui/button";
import { listCreatorHistoryItems } from "@/lib/creator/review";
import { formatDateTime } from "@/lib/datetime";
import { t } from "@/lib/i18n";
import { requireUserId } from "@/lib/session";
import { getUserLanguage, getUserTimezone } from "@/lib/users";

export const metadata: Metadata = {
  title: "Answer history — Koqentra",
  description: "The judgements you have already answered.",
};

// Everything here comes from the account's own rows, so this page must not be
// prerendered.
export const dynamic = "force-dynamic";

/**
 * What was already answered.
 *
 * **A read, and nothing else.** There is no action on this page, no form and no
 * button that changes anything: feedback is append-only, so there is nothing
 * here to undo, redo or delete. That is also why it never reaches the
 * provisioning boundary — looking at a record must not bring an account row
 * into being.
 *
 * **The mirror of the inbox rather than a replacement for it.** A piece whose
 * judgements are half answered is on both screens, showing different halves of
 * itself; the note below says so, because two headings with the same title
 * would otherwise read as a bug.
 */
export default async function CreatorHistoryPage() {
  const userId = await requireUserId();
  const [language, timezone, items] = await Promise.all([
    getUserLanguage(userId),
    getUserTimezone(userId),
    listCreatorHistoryItems(userId),
  ]);

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {t(language, "creator.history.title")}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(language, "creator.history.description")}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href="/creator" />}
            >
              {t(language, "creator.inbox.title")}
            </Button>
            <Button nativeButton={false} render={<Link href="/creator/new" />}>
              {t(language, "creator.inbox.analyzeCta")}
            </Button>
          </div>
        </div>

        {items.length === 0 ? (
          <div className="mt-10 rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-sm font-medium">
              {t(language, "creator.history.emptyTitle")}
            </p>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              {t(language, "creator.history.emptyBody")}
            </p>
            <div className="mt-6 flex justify-center">
              <Button nativeButton={false} render={<Link href="/creator" />}>
                {t(language, "creator.inbox.title")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* **Said once, at the top.** The same analysis can be on both
                screens, and somebody seeing its title in two places deserves to
                know that is the design rather than a duplicate. */}
            <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
              {t(language, "creator.history.pendingNote")}
            </p>

            <div className="mt-6 flex flex-col gap-8">
              {items.map((item) => (
                <section key={item.contentItemId}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-lg font-medium tracking-tight">
                      {item.title ?? t(language, "creator.inbox.untitled")}
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      {t(language, "creator.history.answeredCount", {
                        count: String(item.decisions.length),
                      })}
                    </span>
                  </div>

                  {/* **What tells two submissions of the same piece apart.**
                      Absolute, in the account's own zone — a relative time
                      would be friendlier and would not answer the question. */}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(language, "creator.inbox.analyzedAt", {
                      at: formatDateTime(item.analyzedAt, timezone),
                    })}
                  </p>

                  {/* **Where this came from, when it came from somewhere.** A
                      pasted piece has no source to name, so nothing is shown for
                      one — an empty label would read as a page that failed to
                      load. The address is the one the body was actually read
                      from, after redirects.

                      `break-all` because a long URL is one unbroken token and
                      would otherwise widen the page on a phone; the `href` is
                      always the whole address. */}
                  {item.source.kind === "url" ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(language, "creator.source.page")}:{" "}
                      <a
                        href={item.source.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="break-all underline underline-offset-4"
                      >
                        {item.source.url}
                      </a>
                    </p>
                  ) : null}

                  {/* An excerpt, not the piece: the whole body never reaches a
                      browser, here or on the inbox. */}
                  <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    {item.sourceExcerpt}
                  </p>

                  <div className="mt-4 flex flex-col gap-3">
                    {item.decisions.map((decision) => (
                      <CreatorHistoryDecisionCard
                        key={decision.id}
                        decision={decision}
                        language={language}
                        timezone={timezone}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
