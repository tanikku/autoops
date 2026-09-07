"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { type Language, t } from "@/lib/i18n";

/**
 * The three links in the bar, and which of them the reader is standing on.
 *
 * **A client component for one reason: the bar has to know its own route.**
 * `DashboardNav` around it stays on the server, where the session, the language
 * and the sign-out action belong; nothing about who is signed in crosses into
 * here. The only prop is the language, because that is all a link needs to name
 * itself.
 *
 * **Saying nothing beats saying the wrong thing.** `aria-current="page"` used
 * to be hard-coded on the Worker link, so a screen reader was told Dashboard
 * was the current page while somebody stood on Creator or Settings. It was
 * removed rather than guessed at, which left the bar accurate but silent. This
 * is the part that was deferred: knowing the route, and only then claiming a
 * current item — and still claiming none when the route is not one of these.
 */

/** Where each link goes, and the section it stands for. */
const CREATOR_ROOT = "/creator";
const WORKERS_ROOT = "/dashboard";
const SETTINGS_ROOT = "/dashboard/settings";

type NavSection = "creator" | "workers" | "settings";

/**
 * Whether a path is this section's own, on a segment boundary.
 *
 * **`startsWith` alone is the bug this avoids.** `/creatorish` begins with
 * `/creator` and is not Creator; `/dashboardish` is not Workers. A path belongs
 * to a root when it *is* that root or continues past a `/`, which is where a
 * route segment actually ends.
 */
function isWithin(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

/**
 * Which of the three sections a path belongs to, or none.
 *
 * **Settings is asked first because it lives inside Workers.** Its route is
 * `/dashboard/settings`, so a shallower test would answer Workers for it and
 * two links would claim to be current at once. Order is what keeps the answer
 * single.
 */
function currentSection(pathname: string): NavSection | null {
  if (isWithin(pathname, SETTINGS_ROOT)) {
    return "settings";
  }

  if (isWithin(pathname, WORKERS_ROOT)) {
    return "workers";
  }

  if (isWithin(pathname, CREATOR_ROOT)) {
    return "creator";
  }

  // A route the bar does not cover — the landing page, the privacy notice, or
  // something added later. None of these three is where the reader is.
  return null;
}

/**
 * What to claim about a link, if anything.
 *
 * **`page` and `location` are different claims and both are needed here.**
 * These links point at section roots, so on `/creator` the Creator link really
 * is the current page — but on `/creator/new` it is not; it is the section the
 * current page sits in, which is what `location` says. Calling the second one
 * `page` would tell a screen reader the reader is somewhere they are not.
 */
function ariaCurrent(
  pathname: string,
  root: string,
  section: NavSection,
  current: NavSection | null,
): "page" | "location" | undefined {
  if (current !== section) {
    return undefined;
  }

  return pathname === root ? "page" : "location";
}

export function DashboardNavLinks({ language }: { language: Language }) {
  const pathname = usePathname();
  // `usePathname` is typed as a string, but a value this component cannot read
  // is the same situation as a route it does not cover: claim nothing.
  const here = typeof pathname === "string" ? pathname : "";
  const current = currentSection(here);

  const links = [
    { section: "creator", root: CREATOR_ROOT, label: "nav.creator" },
    { section: "workers", root: WORKERS_ROOT, label: "nav.workers" },
    { section: "settings", root: SETTINGS_ROOT, label: "nav.settings" },
  ] as const;

  return (
    /* **The wrapping is the mobile fix and stays exactly as it was.** Three
       links, an account name and a sign out do not fit on a 375px row, so the
       links take a row of their own below `sm` and rejoin above it. */
    <nav className="order-last flex w-full flex-wrap items-center gap-1 sm:order-none sm:w-auto sm:flex-nowrap">
      {links.map(({ section, root, label }) => (
        <Button
          key={root}
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={
            /* **On the anchor itself.** `aria-current` describes the link a
               reader lands on; on a wrapper it would describe nothing they can
               reach. */
            <Link
              href={root}
              aria-current={ariaCurrent(here, root, section, current)}
            />
          }
        >
          {t(language, label)}
        </Button>
      ))}
    </nav>
  );
}
