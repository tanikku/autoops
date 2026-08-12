import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { isBetaSignInAllowed, parseBetaAllowlist } from "@/lib/beta-access";

/**
 * Read once, as the provider factory reads its own key once.
 *
 * Changing who may sign in therefore takes a restart rather than effect on the
 * next request. That is stated in the README instead of being worked around:
 * re-reading the environment per sign-in would buy nothing here, where the list
 * changes when someone is invited and not otherwise.
 */
const betaAllowlist = parseBetaAllowlist(process.env.BETA_ALLOWED_EMAILS);

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [Google],
  // JWT sessions keep auth self-contained: no database adapter, so the
  // middleware can run on the edge without a DB round trip.
  session: { strategy: "jwt" },
  pages: {
    // Unauthenticated visitors land on the marketing page, which carries the
    // Google sign-in button.
    signIn: "/",
    // A refused sign-in comes back to the same page. Auth.js appends
    // `?error=AccessDenied` and nothing else — no address, no list — and the
    // page says only that the beta is invite-only.
    error: "/",
  },
  callbacks: {
    /**
     * Closed Beta admission, and only that.
     *
     * **Refusing here is refusing before anything exists.** Returning false
     * stops the flow ahead of `jwt`, so no token is minted, no session cookie
     * is set, and no `User` row is written — that row is created at the
     * provisioning boundary, which a session is required to reach. A refused
     * visitor leaves no trace to clean up.
     *
     * **Nothing about the refusal is logged.** The address that was turned
     * away and the list it was compared against are both things a log would
     * then be storing, and the person it concerns already learns the outcome
     * from the page they land on.
     */
    signIn: ({ profile }) => isBetaSignInAllowed(profile, betaAllowlist),
    authorized: ({ auth }) => Boolean(auth),
    // `token.sub` must be the Google account id, which is stable for the life
    // of the account: it is the tenant key every owned row is scoped by.
    //
    // Deliberately not `user.id` — without a database adapter that is a UUID
    // minted per sign-in, so every sign-in would have looked like a new tenant
    // and hidden the account's own workers.
    //
    // `account` is only present on the sign-in that issues the token; later
    // calls carry the value forward in `token.sub`.
    jwt: ({ token, account }) => {
      if (account?.providerAccountId) {
        token.sub = account.providerAccountId;
      }
      return token;
    },
    session: ({ session, token }) => {
      if (token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
});
