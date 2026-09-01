import Link from "next/link";
import { signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import { GitHubIcon } from "@/components/icons";

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
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  const refused = error === "AccessDenied";

  return (
    <div className="flex flex-1 flex-col bg-background">
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

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-24 text-center sm:px-10">
        <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
          Automate recurring AI workflows.
        </h1>

        <p className="mt-6 text-balance text-lg text-muted-foreground sm:text-xl">
          Create AI routines once. Run forever.
        </p>

        {refused ? (
          <p className="mt-8 max-w-md text-balance rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
            Koqentra is in Closed Beta and sign-in is limited to invited
            accounts.
          </p>
        ) : null}

        <div className="mt-10 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/dashboard" });
            }}
            className="w-full sm:w-auto"
          >
            <Button type="submit" size="lg" className="w-full sm:w-auto">
              Continue with Google
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
      </main>

      <footer className="mx-auto w-full max-w-6xl px-6 py-8 text-center text-sm text-muted-foreground sm:px-10">
        © {new Date().getFullYear()} Koqentra · Closed Beta ·{" "}
        <Link href="/privacy" className="underline-offset-4 hover:underline">
          Privacy
        </Link>
      </footer>
    </div>
  );
}
