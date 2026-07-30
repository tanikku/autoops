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
  },
});
