import { readAccessMode, readPublicBetaSignup } from "@/lib/beta-access";
import { prisma } from "@/lib/prisma";
import { describePublicBetaAdmissions } from "@/lib/public-beta-admission";

/**
 * How many Public Beta places are taken. Read only, counts only.
 *
 * Run on the service, where the mode and the cap are the ones in effect:
 * `node dist/ops/public-beta-admissions.mjs`. The count is read inside a
 * read-only transaction, so this cannot change anything it looks at.
 */
const admitted = await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SET TRANSACTION READ ONLY`;
  return tx.publicBetaAdmission.count();
});

console.log(
  describePublicBetaAdmissions({
    admitted,
    mode: readAccessMode(process.env.AUTH_ACCESS_MODE),
    signup: readPublicBetaSignup({
      PUBLIC_BETA_SIGNUP_ENABLED: process.env.PUBLIC_BETA_SIGNUP_ENABLED,
      PUBLIC_BETA_SIGNUP_LIMIT: process.env.PUBLIC_BETA_SIGNUP_LIMIT,
    }),
  }),
);

await prisma.$disconnect();
