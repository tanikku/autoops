import Link from "next/link";
import { auth, signOut } from "@/auth";
import { Button } from "@/components/ui/button";

export async function DashboardNav() {
  const session = await auth();
  const userName = session?.user?.name ?? session?.user?.email ?? "Signed in";

  return (
    <header className="border-b border-border">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-6 py-4 sm:px-10">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          AutoOps
        </Link>

        <nav className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<Link href="/dashboard" aria-current="page" />}
          >
            Dashboard
          </Button>
          <Button variant="ghost" size="sm" disabled>
            Settings
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
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
