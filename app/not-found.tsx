import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Not Found — AutoOps",
};

/**
 * Where `notFound()` lands, and where an unmatched URL lands with it.
 *
 * Most arrivals are the first kind: the worker and run pages call it both for
 * a record that does not exist and for one belonging to another account, so
 * the wording has to fit a worker that was deleted a minute ago as well as one
 * that was never this visitor's to see. Saying more would answer the question
 * that returning 404 rather than 403 exists to leave unanswered.
 *
 * No dashboard nav here: this also catches unmatched public URLs, where there
 * may be nobody signed in to render it for.
 */
export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <header className="mx-auto flex w-full max-w-6xl items-center px-6 py-6 sm:px-10">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          AutoOps
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-6 py-24 text-center sm:px-10">
        <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
          Not found.
        </h1>

        <p className="mt-4 text-balance text-muted-foreground">
          This page does not exist, or is not available on your account.
        </p>

        <div className="mt-8">
          <Button
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
