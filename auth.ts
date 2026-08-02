import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [Google],
  // JWT sessions keep auth self-contained: no database adapter, so the
  // middleware can run on the edge without a DB round trip.
  session: { strategy: "jwt" },
  pages: {
    // Unauthenticated visitors land on the marketing page, which carries the
    // Google sign-in button.
    signIn: "/",
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
});
