import Link from "next/link";
import { Button } from "@/components/ui/button";

export function DashboardNav() {
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
            render={<Link href="/dashboard" aria-current="page" />}
          >
            Dashboard
          </Button>
          <Button variant="ghost" size="sm" disabled>
            Settings
          </Button>
        </nav>

        <div
          aria-label="User avatar placeholder"
          className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
        >
          AO
        </div>
      </div>
    </header>
  );
}
