import Link from "next/link";
import { auth, signOut } from "@/auth";
import { Button } from "@/components/ui/button";
import { DEFAULT_LANGUAGE, t } from "@/lib/i18n";
import { getUserLanguage } from "@/lib/users";

/**
 * The bar every signed-in page carries.
 *
 * **It reads the language itself rather than being handed one.** Six pages
 * render this, and threading a prop through all of them would mean each one
 * fetching a setting it does not otherwise use — including the four that are
 * still English. It already asks who is signed in, so the account row is one
 * more question to something it was going to talk to anyway.
 *
 * A session with no id cannot own a language, so the default answers instead —
 * without a query, and without a write.
 */
export async function DashboardNav() {
  const session = await auth();
  const userId = session?.user?.id;
  const language = userId ? await getUserLanguage(userId) : DEFAULT_LANGUAGE;
  const userName =
    session?.user?.name ?? session?.user?.email ?? t(language, "nav.signedIn");

  return (
    <header className="border-b border-border">
      {/* **Three links no longer fit beside an account name on a phone.**
          Rather than hiding anything, the bar wraps: the brand and the account
          controls keep the first row, and the links drop to a second one below
          360px-ish. `order-last w-full` does that on small screens and is
          undone from `sm` up, so the desktop bar is the single row it has
          always been. Nothing is removed — sign out least of all. */}
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:flex-nowrap sm:px-10 sm:py-4">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Koqentra
        </Link>

        {/* **No `aria-current` on any of these links.** It used to be
            hard-coded on Dashboard, which told a screen reader that Dashboard
            was the current page while somebody stood on `/creator` or Settings
            — a wrong answer given confidently. Saying nothing is the accurate
            state until the bar knows which route it is on, and knowing that
            needs either the pathname or a prop from every page: a design
            question for a UX checkpoint rather than something to guess at
            here. */}
        <nav className="order-last flex w-full flex-wrap items-center gap-1 sm:order-none sm:w-auto sm:flex-nowrap">
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<Link href="/dashboard" />}
          >
            {t(language, "nav.dashboard")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<Link href="/creator" />}
          >
            {t(language, "nav.creator")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<Link href="/dashboard/settings" />}
          >
            {t(language, "nav.settings")}
          </Button>
        </nav>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {/* Narrower before `sm`, so a long address cannot push sign out off
              the edge on a phone. */}
          <span className="max-w-[7rem] truncate text-sm text-muted-foreground sm:max-w-[12rem]">
            {userName}
          </span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <Button type="submit" variant="ghost" size="sm">
              {t(language, "nav.signOut")}
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
