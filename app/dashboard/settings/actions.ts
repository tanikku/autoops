"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/session";
import { isSupportedTimezone } from "@/lib/timezones";
import { setUserTimezone } from "@/lib/users";
import type { ActionResult } from "@/types";

export type UpdateTimezoneState = ActionResult | null;

export async function updateTimezoneAction(
  _prevState: UpdateTimezoneState,
  formData: FormData,
): Promise<UpdateTimezoneState> {
  // The owner comes from the session, never from the submitted form.
  const userId = await requireUserId();
  const timezone = String(formData.get("timezone") ?? "");

  // Rejected rather than corrected: an unrecognised zone would make `Intl`
  // throw on every render, and it decides when scheduled workers run.
  if (!isSupportedTimezone(timezone)) {
    return { status: "error", message: "Select a timezone from the list." };
  }

  try {
    await setUserTimezone(userId, timezone);
  } catch (error) {
    console.error("[settings] timezone update failed", error);
    return { status: "error", message: "Could not save your timezone." };
  }

  // Every screen renders timestamps, and the workers list reads the same value
  // through the cards, so the whole dashboard is stale after this.
  revalidatePath("/dashboard", "layout");

  return { status: "success", message: "Timezone saved." };
}
