import "server-only";

import { redirect } from "next/navigation";
import { auth } from "@/auth";

/**
 * The tenant key for the current request.
 *
 * The middleware already gates `/dashboard`, so this is a defence-in-depth
 * check: server actions and pages must never fall back to an unscoped query.
 */
export async function requireUserId(): Promise<string> {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/");
  }

  return session.user.id;
}
