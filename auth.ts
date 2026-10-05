import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";
import {
  parseBetaAllowlist,
  readAccessMode,
  readPublicBetaSignup,
} from "@/lib/beta-access";
import { prisma } from "@/lib/prisma";
import {
  admitToPublicBeta,
  decideSignIn,
  isKnownSubject,
} from "@/lib/public-beta-admission";

/**
 * Read once, as the provider factory reads its own key once.
 *
 * Changing who may sign in therefore takes a restart rather than effect on the
 * next request. That is stated in the README instead of being worked around:
 * re-reading the environment per sign-in would buy nothing here, where the list
 * changes when someone is invited and not otherwise. The access mode and the
 * Public Beta switch and cap are read the same way, for the same reason.
 */
const betaAllowlist = parseBetaAllowlist(process.env.BETA_ALLOWED_EMAILS);
const accessMode = readAccessMode(process.env.AUTH_ACCESS_MODE);
const publicBetaSignup = readPublicBetaSignup({
  PUBLIC_BETA_SIGNUP_ENABLED: process.env.PUBLIC_BETA_SIGNUP_ENABLED,
  PUBLIC_BETA_SIGNUP_LIMIT: process.env.PUBLIC_BETA_SIGNUP_LIMIT,
});

/**
 * Not imported by the middleware — `auth.config.ts` is — so the sign-in
 * decision may ask the database.
 */
export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    /**
     * Who may sign in.
     *
     * **An existing user is let in in either mode** — an allowlisted address,
     * an account, or a Public Beta place already taken. Somebody new is
     * refused in Closed Beta, and in Public Beta is admitted while a place is
     * left (see `decideSignIn`). A new participant who cannot be taken in is
     * sent back to the landing page with only `signup=full` or `signup=closed`.
     *
     * **Refusing here is refusing before anything exists.** Returning false or
     * a path stops the flow ahead of `jwt`, so no token is minted, no session
     * cookie is set, and no `User` row is written — that row is created at the
     * provisioning boundary, which a session is required to reach.
     *
     * **Nothing about the refusal is logged.** The address that was turned
     * away and the list it was compared against are both things a log would
     * then be storing, and the person it concerns already learns the outcome
     * from the page they land on.
     */
    signIn: ({ profile, account }) =>
      decideSignIn(
        {
          mode: accessMode,
          profile,
          userId: account?.providerAccountId,
          allowlist: betaAllowlist,
          signup: publicBetaSignup,
        },
        {
          isKnown: (userId) => isKnownSubject(prisma, userId),
          admit: (userId, limit) => admitToPublicBeta(prisma, userId, limit),
        },
      ),
  },
});
