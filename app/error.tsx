"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * What every page under `app/` falls back to when rendering throws.
 *
 * **Nothing about the error itself is shown.** Next.js already replaces the
 * message with an opaque digest in production, and the reason a query failed
 * is a server concern — `console.error` in the action or route has it, and a
 * visitor can do nothing with it either way. What they can do is try again,
 * which is what `reset` re-runs.
 *
 * Errors thrown by the root layout are not caught here; that needs
 * `global-error.tsx`, which this app does not have.
 */
export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    // **`lang` on the fallback, not on the document.** Everything below is
    // written in English and is not translated: it stands in for a page that
    // failed, and a person who cannot see the page they asked for is better
    // served by words that certainly exist than by a translation of them. The
    // document around it may well say `lang="ja"` — the root layout writes the
    // account's language — so without this the browser and any screen reader
    // would be told to read English sentences as Japanese. Declaring the
    // exception here is what HTML has language-of-parts for.
    <div lang="en" className="flex flex-1 flex-col bg-background">
      <header className="mx-auto flex w-full max-w-6xl items-center px-6 py-6 sm:px-10">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Koqentra
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-6 py-24 text-center sm:px-10">
        <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>

        <p className="mt-4 text-balance text-muted-foreground">
          The page could not be loaded. Your workers and their history are
          unaffected.
        </p>

        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
          <Button onClick={reset}>Try again</Button>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/dashboard" />}
          >
            Back to Dashboard
          </Button>
        </div>
      </main>
    </div>
  );
}
