import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

// The edge-safe half of the auth configuration: reading a session never needs
// the database, and deciding a sign-in — which may — is `auth.ts`'s alone.
export const { auth: middleware } = NextAuth(authConfig);

/**
 * The signed-in areas, and only those.
 *
 * The landing page and `/privacy` stay public — the second deliberately, since
 * a privacy notice that only account holders can read is not much of one.
 *
 * **Each page still asks for a session itself.** This matcher is one line in
 * one file; a page that trusted it would be trusting an edit nobody has made
 * yet. Adding a route here without the page's own `requireUserId` would leave
 * the guard resting entirely on remembering to come back to this list.
 */
export const config = {
  matcher: ["/dashboard/:path*", "/creator/:path*"],
};
