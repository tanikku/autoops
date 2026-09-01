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
      <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-6 py-4 sm:px-10">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Koqentra
        </Link>

        <nav className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<Link href="/dashboard" aria-current="page" />}
          >
            {t(language, "nav.dashboard")}
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

        <div className="ml-auto flex items-center gap-3">
          <span className="max-w-[12rem] truncate text-sm text-muted-foreground">
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
