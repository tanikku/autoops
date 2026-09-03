/**
 * The zones a user may choose from.
 *
 * A short list rather than the full IANA database: several hundred entries
 * make a select unusable, and most of them are aliases or historical. This
 * covers the regions AutoOps expects to serve, and grows by adding a line.
 *
 * The value stored is the IANA identifier, which is what `Intl` reads. The
 * label is only what the option says.
 */
export const supportedTimezones = [
  { value: "UTC", label: "UTC" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Asia/Seoul", label: "Seoul" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "America/New_York", label: "New York" },
  { value: "America/Chicago", label: "Chicago" },
  { value: "America/Denver", label: "Denver" },
  { value: "America/Los_Angeles", label: "Los Angeles" },
  { value: "Australia/Sydney", label: "Sydney" },
] as const;

export type SupportedTimezone = (typeof supportedTimezones)[number]["value"];

/**
 * The zone an account has before anybody chooses one.
 *
 * **It must stay equal to `User.timezone`'s `@default`.** The column is what
 * actually decides a new row's zone — `ensureUser` omits it — and this is what
 * the dashboard shows for an account whose row does not exist yet, which is
 * every account until its first write. Two different answers would tell a
 * first-time user their worker runs at 09:00 in one zone and then schedule it
 * in another.
 *
 * Asia/Tokyo rather than UTC because that is where the Closed Beta's users
 * are. **Nothing about UTC was removed**: it is still in the list above, and
 * an account that selects it keeps it.
 *
 * Typed as `SupportedTimezone` so a value the selector cannot offer — and
 * `isSupportedTimezone` would therefore reject on the way back in — does not
 * compile.
 */
export const NEW_ACCOUNT_TIMEZONE: SupportedTimezone = "Asia/Tokyo";

/**
 * Guards the write.
 *
 * The select can only submit these values, but a form post is not a promise —
 * anything can be sent. Checking here means an unrecognised zone never reaches
 * the column that decides when workers run.
 */
export function isSupportedTimezone(value: string): value is SupportedTimezone {
  return supportedTimezones.some((zone) => zone.value === value);
}
