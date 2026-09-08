import type { Metadata } from "next";
import Link from "next/link";
import { CreatorHistoryDecisionCard } from "@/components/creator-history-decision-card";
import { DashboardNav } from "@/components/dashboard-nav";
import { Button } from "@/components/ui/button";
import {
  type CreatorHistoryCursor,
  listCreatorHistoryPage,
} from "@/lib/creator/review";
import { formatDateTime } from "@/lib/datetime";
import { t } from "@/lib/i18n";
import { getDocumentLanguage } from "@/lib/i18n/server";
import { requireUserId } from "@/lib/session";
import { getUserLanguage, getUserTimezone } from "@/lib/users";

/**
 * The title and description in the language the screen itself is in.
 *
 * **The document already says which language it is.** `app/layout.tsx` writes
 * the account's language onto `<html>`, and everything visible here follows
 * it — so a title left in English would be the one part of the page
 * contradicting the attribute around it, which is exactly what a screen
 * reader believes when it chooses a voice.
 *
 * **The heading is reused; the description is its own string.** The title is
 * the same words the page leads with, so there is one place to change them.
 * The description has to say what this screen is to somebody reading a tab
 * strip rather than the screen, which is a different sentence — see the note
 * beside `creator.history.metadataDescription` in the dictionary.
 *
 * **Read-only.** `getDocumentLanguage` decodes the session and falls back to
 * English; no account row is read into existence to render a title.
 */
export async function generateMetadata(): Promise<Metadata> {
  const language = await getDocumentLanguage();

  return {
    title: `${t(language, "creator.history.title")} — Koqentra`,
    description: t(language, "creator.history.metadataDescription"),
  };
}

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
/**
 * Where in the record to continue from, or null for the newest answers.
 *
 * **Both halves or neither.** The pair names a position in an ordering whose
 * tie-break is the id, so half of it is not a position. A malformed value is a
 * broken link rather than an attack — the query is scoped to this account
 * regardless — so the answer is the first page, not a 404 and not an error.
 */
function readHistoryCursor(
  query: Record<string, string | string[] | undefined>,
): CreatorHistoryCursor | null {
  const analyzedAt =
    typeof query.historyBefore === "string" ? query.historyBefore : "";
  const contentItemId =
    typeof query.historyBeforeId === "string" ? query.historyBeforeId.trim() : "";

  if (analyzedAt === "" || contentItemId === "") {
    return null;
  }

  const at = new Date(analyzedAt);

  return Number.isNaN(at.getTime()) ? null : { analyzedAt: at, contentItemId };
}

export default async function CreatorHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const userId = await requireUserId();
  const cursor = readHistoryCursor(await searchParams);
  const [language, timezone, page] = await Promise.all([
    getUserLanguage(userId),
    getUserTimezone(userId),
    listCreatorHistoryPage(userId, cursor),
  ]);
  const items = page.items;

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

        {/* **Navigation, not an append.** Each of these loads a different page
            of the same record on the server, which is why the words say
            "older" and "latest" rather than "load more" — the list above is
            replaced, not extended.

            **Outside the empty state on purpose.** A cursor page can legitimately
            come back with nothing on it, and somebody who has walked back
            through the record still needs the way out. */}
        {page.nextCursor === null && cursor === null ? null : (
          <div className="mt-8 flex flex-wrap items-center gap-2">
            {cursor === null ? null : (
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={<Link href="/creator/history" />}
              >
                {t(language, "creator.history.backToLatest")}
              </Button>
            )}
            {page.nextCursor === null ? null : (
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={
                  /* Built as a query object so the timestamp's colons and the
                     id are escaped by the framework rather than by hand. */
                  <Link
                    href={{
                      pathname: "/creator/history",
                      query: {
                        historyBefore: page.nextCursor.analyzedAt.toISOString(),
                        historyBeforeId: page.nextCursor.contentItemId,
                      },
                    }}
                  />
                }
              >
                {t(language, "creator.history.olderAnswers")}
              </Button>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
