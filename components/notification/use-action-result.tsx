"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useNotify } from "@/components/notification/notification-provider";
import type { ActionResult } from "@/types";

/**
 * Turns a server action's result into a toast, and optionally navigates on
 * success.
 *
 * The toast is raised from the root layout's provider, so it outlives the
 * navigation that follows it.
 */
export function useActionResult(
  result: ActionResult | null,
  options: { redirectTo?: string } = {},
) {
  const notify = useNotify();
  const router = useRouter();
  const { redirectTo } = options;

  useEffect(() => {
    if (!result) {
      return;
    }

    notify({ type: result.status, message: result.message });

    if (result.status === "success" && redirectTo) {
      router.push(redirectTo);
    }
  }, [result, notify, router, redirectTo]);
}
