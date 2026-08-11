"use server";

import { revalidatePath } from "next/cache";
import {
  isUserProvisioningError,
  requireProvisionedUserId,
  requireUserId,
} from "@/lib/session";
import { isSupportedTimezone } from "@/lib/timezones";
import { setUserTimezone } from "@/lib/users";
import type { ActionResult } from "@/types";

export type UpdateTimezoneState = ActionResult | null;

export async function updateTimezoneAction(
  _prevState: UpdateTimezoneState,
  formData: FormData,
): Promise<UpdateTimezoneState> {
  // **Who is asking comes first, and it is only a question.** A visitor with
  // no session is sent to sign in before anything they submitted is read,
  // whether or not it was valid. This writes nothing — provisioning is a
  // separate step, below, and deliberately not part of authenticating.
  await requireUserId();

  const timezone = String(formData.get("timezone") ?? "");

  // Rejected rather than corrected: an unrecognised zone would make `Intl`
  // throw on every render, and it decides when scheduled workers run.
  //
  // **Before the account row is provisioned, deliberately.** A submission that
  // cannot be saved must not create the row that saving it would have needed.
  // Nothing has been written above this line.
  if (!isSupportedTimezone(timezone)) {
    return { status: "error", message: "Select a timezone from the list." };
  }

  // The owner comes from the session, never from the submitted form — the same
  // session the check above read. **The row it names may not exist yet**:
  // sessions are JWT-only, so nothing writes the account row at sign-in, and an
  // account that has never created a worker reaches this page without one. The
  // timezone is a column on that row, so there is nothing to update until it is
  // there.
  let userId: string;
  try {
    userId = await requireProvisionedUserId();
  } catch (error) {
    // A redirect leaves by being thrown too, so anything that is not a
    // provisioning failure has to carry on out of here — catching it would
    // show a signed-out visitor a form error instead of the sign-in page.
    if (!isUserProvisioningError(error)) {
      throw error;
    }

    // A separate line from the one below: the two failures are the same
    // sentence to whoever pressed Save, and different events to whoever reads
    // the log.
    console.error("[settings] could not provision the account row", error);
    return { status: "error", message: "Could not save your timezone." };
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
