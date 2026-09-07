import "server-only";

import { auth } from "@/auth";
import { DEFAULT_LANGUAGE, type Language } from "@/lib/i18n";
import { getUserLanguage } from "@/lib/users";

/**
 * Which language this request's document is written in.
 *
 * **Kept apart from `lib/i18n/index.ts` on purpose.** That module is the closed
 * set of languages and the dictionary lookup, and nothing in it knows about a
 * request; it is imported by components that render on either side of the
 * client boundary. This one reads the session, so it is server-only, and
 * putting it beside the dictionaries would drag `auth` — and a database client
 * behind it — into every module that only wanted a translated string.
 *
 * **Kept out of `lib/users.ts` for the same reason in reverse.** That file is
 * the boundary for reading and writing a `User` row. Deciding what a request's
 * document language is happens one level above that: it asks who is here first,
 * and only then reads a row — and for most public requests it never reads one
 * at all.
 */

/**
 * The language for the current request, and never a guess.
 *
 * **A session, not a browser.** `Accept-Language`, `navigator.language`, the
 * account's timezone and where the request came from are all evidence about a
 * device rather than a decision somebody made. Koqentra has one answer to this
 * question — the language stored on the account — and English until somebody
 * says otherwise. Guessing from a header would mean a person who set English
 * being handed Japanese by their own phone.
 *
 * **Reading, all the way down.** `auth()` decodes the session cookie and
 * `getUserLanguage` falls back rather than writing, so this runs on the public
 * landing page and the privacy notice without provisioning an account row for
 * a visitor who may not even have one. There is no path from here to
 * `requireProvisionedUserId`.
 *
 * **Anonymous costs no query.** Without an id there is no row to read and
 * English is the answer, so the database is never asked on a signed-out
 * request.
 */
export async function getDocumentLanguage(): Promise<Language> {
  const session = await auth();
  const userId = session?.user?.id;

  return userId ? await getUserLanguage(userId) : DEFAULT_LANGUAGE;
}
