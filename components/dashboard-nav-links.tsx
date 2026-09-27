"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * The three links in the bar, and which of them the reader is standing on.
 *
 * **A client component for one reason: the bar has to know its own route.**
 * `DashboardNav` around it stays on the server, where the session, the language
 * and the sign-out action belong; nothing about who is signed in crosses into
 * here.
 *
 * **The labels arrive already translated, and that is deliberate.** Taking a
 * language and calling `t()` here would pull `lib/i18n` across the boundary —
 * and with it both dictionaries, every string in the product, into the browser
 * bundle of every signed-in page. Three words are what this needs, the server
 * has already looked them up for its own use, so it hands over the words
 * instead of the means to find them.
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
const WORKERS_ROOT = "/dashboard/workers";
const PLANS_ROOT = "/dashboard/billing";
const SETTINGS_ROOT = "/dashboard/settings";

/**
 * Where the bar's own brand link goes, and the one route no link claims.
 *
 * **Home is not in the bar.** It is what the logo goes to and what signing in
 * lands on, so a fifth link would be a second way to the place somebody is
 * already standing. Standing on it, therefore, no feature link is current — and
 * that is a claim worth making rather than a gap: the reader is not in Creator,
 * or Workers, or Plans, or Settings.
 */
const HOME = "/dashboard";

/**
 * Two routes belong to Workers without living under its root.
 *
 * Hiring a worker is `/dashboard/new` and a run's detail is `/dashboard/runs/…`;
 * both are places the Workers screen sends people, and a reader who followed one
 * is still in Workers. They are listed rather than matched loosely, because
 * `/dashboard/…` now also covers Home, Plans and Settings.
 */
const WORKERS_ALSO = ["/dashboard/new", "/dashboard/runs"] as const;

type NavSection = "creator" | "workers" | "plans" | "settings";

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
 * Which section a path belongs to, or none.
 *
 * **Home is asked first and answers nothing.** `/dashboard` is its own screen
 * now; it used to be the workers list, and a test that still fell through to
 * Workers would mark a link for a page the reader has left.
 *
 * **Then the roots, each exact enough to be single.** Settings, Plans and
 * Workers all sit under `/dashboard`, so they are compared against their own
 * roots rather than against a shared prefix — which is what keeps exactly one
 * link current.
 */
function currentSection(pathname: string): NavSection | null {
  if (pathname === HOME) {
    return null;
  }

  if (isWithin(pathname, SETTINGS_ROOT)) {
    return "settings";
  }

  if (isWithin(pathname, PLANS_ROOT)) {
    return "plans";
  }

  if (
    isWithin(pathname, WORKERS_ROOT) ||
    WORKERS_ALSO.some((root) => isWithin(pathname, root))
  ) {
    return "workers";
  }

  if (isWithin(pathname, CREATOR_ROOT)) {
    return "creator";
  }

  // A route the bar does not cover — the landing page, the privacy notice, or
  // something added later. None of these four is where the reader is.
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

export function DashboardNavLinks({
  creatorLabel,
  workersLabel,
  plansLabel,
  settingsLabel,
}: {
  creatorLabel: string;
  workersLabel: string;
  plansLabel: string;
  settingsLabel: string;
}) {
  const pathname = usePathname();
  // `usePathname` is typed as a string, but a value this component cannot read
  // is the same situation as a route it does not cover: claim nothing.
  const here = typeof pathname === "string" ? pathname : "";
  const current = currentSection(here);

  // **Plans sits after the two the product is about and before Settings.** It is
  // something a reader goes to once and then rarely; putting it ahead of Workers
  // would make the bar lead with money. Home is not among them: the logo goes
  // there, and a link beside these four would be a second way to the same place.
  const links = [
    { section: "creator", root: CREATOR_ROOT, label: creatorLabel },
    { section: "workers", root: WORKERS_ROOT, label: workersLabel },
    { section: "plans", root: PLANS_ROOT, label: plansLabel },
    { section: "settings", root: SETTINGS_ROOT, label: settingsLabel },
  ] as const;

  return (
    /* **The wrapping is the mobile fix and stays exactly as it was.** Four
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
          {label}
        </Button>
      ))}
    </nav>
  );
}
