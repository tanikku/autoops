import "server-only";

import { formatDateTimeWithSeconds } from "@/lib/datetime";
import { isEmailDeliveryError, sendPlainTextEmail, type EmailDeliveryFailure } from "@/lib/notify/email";

/**
 * Tells the operator that somebody new took a Public Beta place.
 *
 * **An internal message, not a product one.** It goes to
 * `PUBLIC_BETA_NOTIFY_EMAIL` and nowhere else — deliberately not to
 * `SUPPORT_EMAIL`, which is the public address people write *to*, and whose
 * absence hides a Contact section. Unset or blank means the notification is
 * off, which is a normal state and so is not logged. English only, since the
 * reader is the operator.
 *
 * **Nothing about the person.** Only the count, the cap and the time: no
 * subject, address, name or anything else from the sign-in, so the message
 * and the log line are both safe to keep.
 */

export type PublicBetaJoin = {
  participants: number;
  limit: number;
  admittedAt: Date;
};

const TOKYO = "Asia/Tokyo";

/** One of a closed set, for the log. Never the thrown value itself. */
type JoinNotificationFailure = EmailDeliveryFailure | "unknown";

export function publicBetaJoinEmail(join: PublicBetaJoin): { subject: string; text: string } {
  // Tokyo keeps no daylight saving, so the zone is always JST.
  const stamp = formatDateTimeWithSeconds(join.admittedAt, TOKYO).slice(0, -TOKYO.length);

  return {
    subject: `[Koqentra] Public Beta participant joined (${join.participants}/${join.limit})`,
    text: [
      "Koqentra Public Beta",
      "",
      "A new participant joined.",
      "",
      `Participants: ${join.participants} / ${join.limit}`,
      `Remaining: ${join.limit - join.participants}`,
      `Joined at: ${stamp}JST`,
    ].join("\n"),
  };
}

/** Never throws: a sign-in that has already been let in must stay let in. */
export async function notifyPublicBetaJoin(join: PublicBetaJoin): Promise<void> {
  try {
    const to = process.env.PUBLIC_BETA_NOTIFY_EMAIL?.trim();
    if (!to) {
      return;
    }

    await sendPlainTextEmail({ to, ...publicBetaJoinEmail(join) });
  } catch (error) {
    const reason: JoinNotificationFailure = isEmailDeliveryError(error) ? error.reason : "unknown";
    console.error("[public-beta-notify] could not send", `reason=${reason}`);
  }
}
