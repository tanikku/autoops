import { parseWatchUrl } from "@/lib/watcher/url";

/**
 * The watched address, as something a person may be handed to open.
 *
 * **Stored is not the same as safe to surface.** `WebsiteSource.url` was
 * checked when it was saved, and the schema says so — but a row written before
 * a rule existed was checked by the rules of its day, and the rules have
 * changed at least once. Re-reading it through the same parser the fetch uses
 * means a link in an email and a link on a page are held to exactly the
 * standard `lib/watcher` holds, rather than to whatever was true when the row
 * was written.
 *
 * **This surfaces a link; it does not fetch one.** What opens it is the
 * reader's own browser, so none of the Safe Fetch protections apply to it and
 * none of them are weakened by it — `assertPublicAddress` and the rest still
 * stand between Koqentra and every request Koqentra makes. What this prevents
 * is narrower and still worth preventing: a scheme that is not a page, an
 * address carrying somebody's credentials, and a stored value that no longer
 * parses at all.
 */

/**
 * The address to offer, or null when there is nothing safe to offer.
 *
 * **Null rather than a broken link.** An action that cannot be completed is
 * worse than no action: somebody following it learns only that Koqentra showed
 * them something that does not work. A worker with no watched page, and one
 * whose stored address no longer passes, both simply have no action.
 *
 * **The address is returned as it was written, not as the parser normalised
 * it.** A query string's order, a trailing slash and the case of a path can
 * all matter to the site being visited, and handing back a rewritten URL would
 * be Koqentra sending somebody somewhere slightly different from the page
 * their worker watches. The parse decides whether to offer it; the stored text
 * is what is offered.
 */
export function monitoredPageLink(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }

  try {
    // Throws for anything that is not an http(s) page, for an address carrying
    // a username or password, and for a value that will not parse.
    parseWatchUrl(url);
  } catch {
    return null;
  }

  return url.trim();
}
