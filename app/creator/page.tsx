import type { Metadata } from "next";
import Link from "next/link";
import { CreatorDecisionCard } from "@/components/creator-decision-card";
import { DashboardNav } from "@/components/dashboard-nav";
import { Button } from "@/components/ui/button";
import { listCreatorReviewItems } from "@/lib/creator/review";
import { t } from "@/lib/i18n";
import { requireUserId } from "@/lib/session";
import { getUserLanguage } from "@/lib/users";

export const metadata: Metadata = {
  title: "Review Inbox — Koqentra",
  description: "What Koqentra suggested, waiting for your answer.",
};

// Everything here comes from the account's own rows, so this page must not be
// prerendered.
export const dynamic = "force-dynamic";

/**
 * What is waiting to be answered.
 *
 * **A read, all the way down.** The list comes from the database and the
 * answers go back through a server action; nothing on this page decides
 * anything, which is why it can be a Server Component with a client component
 * only where a button has to be pressed.
 *
 * **`requireUserId` even though middleware guards the route.** The matcher is
 * one line in one file and a page that trusted it would be trusting an edit
 * nobody made yet; this is the same defence-in-depth every dashboard page has.
 */
export default async function CreatorInboxPage() {
  const userId = await requireUserId();
  const [language, items] = await Promise.all([
    getUserLanguage(userId),
    listCreatorReviewItems(userId),
  ]);

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {t(language, "creator.inbox.title")}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(language, "creator.inbox.description")}
            </p>
          </div>

          <Button nativeButton={false} render={<Link href="/creator/new" />}>
            {t(language, "creator.inbox.analyzeCta")}
          </Button>
        </div>

        {items.length === 0 ? (
          /* **Nothing waiting is the ordinary state.** It reads as a finished
             queue rather than as something that went wrong, and it says what
             would put something in it. */
          <div className="mt-10 rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-sm font-medium">
              {t(language, "creator.inbox.emptyTitle")}
            </p>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              {t(language, "creator.inbox.emptyBody")}
            </p>
            <div className="mt-6 flex justify-center">
              <Button nativeButton={false} render={<Link href="/creator/new" />}>
                {t(language, "creator.inbox.analyzeCta")}
              </Button>
            </div>
          </div>
        ) : (
          /* **One column, on every width.** A long-form post is meant to be
             read before it is agreed to, and columns make that worse rather
             than better. */
          <div className="mt-8 flex flex-col gap-8">
            {items.map((item) => (
              <section key={item.contentItemId}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-lg font-medium tracking-tight">
                    {item.title ?? t(language, "creator.inbox.untitled")}
                  </h2>
                  <span className="text-xs text-muted-foreground">
                    {t(language, "creator.inbox.pending", {
                      count: String(item.decisions.length),
                    })}
                  </span>
                </div>

                {/* **An excerpt, not the piece.** Enough to recognise which
                    submission this is; the whole body never reaches a
                    browser. */}
                <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {item.sourceExcerpt}
                </p>

                <div className="mt-4 flex flex-col gap-3">
                  {item.decisions.map((decision) => (
                    <CreatorDecisionCard
                      key={decision.id}
                      decision={decision}
                      language={language}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
