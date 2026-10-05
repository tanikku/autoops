import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

/**
 * The part of the auth configuration the middleware runs.
 *
 * **Edge-safe on purpose.** The middleware imports this file, and the edge
 * cannot load the database client. Everything that decides who may sign in —
 * and may need to ask the database — lives in `auth.ts`, which only the route
 * handlers and server code load. The middleware never handles a sign-in; it
 * only reads the session these callbacks write.
 */
export const authConfig = {
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
} satisfies NextAuthConfig;
