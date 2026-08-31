import "server-only";

/**
 * Where sending an email stops.
 *
 * **One provider, reached over its HTTP API, and nothing above this line knows
 * that.** The same boundary `lib/ai/` keeps: what leaves here is a delivery
 * that happened or an `EmailDeliveryError` naming one of a closed set of
 * reasons — never a status code, never a response body, never a header, and
 * never the key. A caller that could read the provider's own words would end up
 * putting them somewhere, and the two places a run's words can go are a log an
 * operator reads and an inbox somebody else's address belongs to.
 *
 * **No SDK.** The request is one `POST` of one JSON object, and Node's own
 * `fetch` makes it. A dependency here would be a second copy of retry, timeout
 * and error-shaping policy, all of which this file has to decide anyway because
 * none of the defaults would be the ones AutoOps wants.
 *
 * **JSON rather than SMTP is also what makes the subject safe.** Header
 * injection needs a header to inject into; a string inside a JSON document is
 * a string. The subject is still cleaned of control characters by whoever
 * composes it, because a subject line with a newline in it reads as broken
 * rather than as an attack.
 */

/**
 * How long one send is given, from the request going out to the answer coming
 * back.
 *
 * **Five seconds, and the number comes from what is waiting on it rather than
 * from what the provider needs.** A notification is sent after the run is
 * recorded, so nothing about the run depends on the answer — waiting longer
 * buys the reader nothing that is not already in the database.
 *
 * What waiting does cost is two things that are bounded elsewhere. A
 * hand-started run holds its HTTP response open until the action returns, so
 * this lands on top of a run somebody is watching. And a scheduled tick works
 * through at most `MAX_DISPATCHES_PER_TICK` (5) workers in
 * `MAX_TICK_EXECUTION_MS` (240s), so the worst a tick can spend here is 25
 * seconds — about a tenth of that budget, and a twentieth of the 300 seconds
 * the platform's edge allows.
 *
 * **Deliberately not derived from any AI timeout.** `PROMPT_AI_TIMEOUT_MS` and
 * `WEBSITE_AI_TIMEOUT_MS` bound work the run's result depends on; this bounds
 * a message about a result that already exists. The two would move for
 * unrelated reasons.
 */
export const EMAIL_SEND_TIMEOUT_MS = 5_000;

/** The one endpoint this speaks to. */
const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Why a message did not go out, in words that are safe to write down.
 *
 * **A closed set, and none of it comes from the provider.** Each value is a
 * decision this module made about what happened, which is what lets an operator
 * read the log without the log holding somebody's address or a third party's
 * response body.
 *
 * The same minimal shape as `WatcherErrorKind` and `ProviderErrorKind`, and
 * deliberately not either of them: a rate-limited model and an email that could
 * not be sent have nothing to say to each other.
 */
export type EmailDeliveryFailure =
  /** `RESEND_API_KEY` or `EMAIL_FROM` is not set, so no request was made. */
  | "not-configured"
  /** The call ran out of time, wherever it had got to. */
  | "timeout"
  /** The request never got an answer. */
  | "network"
  /** The provider answered, and its answer was not a success. */
  | "rejected"
  /** A success whose body is not what the API documents. */
  | "unreadable";

/**
 * A send that did not happen, named.
 *
 * The same shape as `WatcherError` — one class, one predicate, no hierarchy.
 * **Whatever the platform threw is deliberately not kept**: a `cause` here
 * would travel to whichever log the caller writes, and the whole point of the
 * boundary is that it cannot.
 */
export class EmailDeliveryError extends Error {
  readonly reason: EmailDeliveryFailure;

  constructor(reason: EmailDeliveryFailure) {
    super(`Email could not be delivered: ${reason}.`);
    this.name = "EmailDeliveryError";
    this.reason = reason;
  }
}

/** Whether a rejection came from this boundary. */
export function isEmailDeliveryError(
  error: unknown,
): error is EmailDeliveryError {
  return error instanceof EmailDeliveryError;
}

/** One message, as this module is willing to send it. */
export type PlainTextEmail = {
  /** The single recipient. There is no list, and no way to pass one. */
  to: string;
  subject: string;
  /** The whole body. **There is no HTML field, deliberately.** */
  text: string;
};

/**
 * The two settings a send needs, read when it is needed.
 *
 * **Read per call rather than once per process**, which is the opposite of how
 * the AI key and the beta allowlist are read — and for a reason each of those
 * has and this does not. Both of those build something at startup (a client, a
 * parsed list); this builds nothing, so there is nowhere for a value read early
 * to live. Reading it here also means a deployment that adds the variables
 * starts sending on restart rather than on the next code change.
 *
 * **Missing is not empty.** A blank string is as unusable as an absent one, and
 * treating them differently would only decide which of two identical failures
 * gets a different name.
 */
function configuration(): { apiKey: string; from: string } {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();

  if (!apiKey || !from) {
    throw new EmailDeliveryError("not-configured");
  }

  return { apiKey, from };
}

/**
 * Sends one plain-text message, or says why it could not.
 *
 * **It throws rather than returning a result**, so that a caller cannot
 * accidentally treat "did not send" as "sent" by ignoring a return value. The
 * one caller catches everything — see `lib/notify/run-notification.ts` — which
 * is where the decision that a failed notification changes nothing about the
 * run is made and written down.
 *
 * **Nothing is retried.** A second attempt would double what a busy provider is
 * being asked for, and a message that arrives twice is worse for the reader
 * than one that does not arrive; the run is recorded either way and the
 * dashboard has it.
 */
export async function sendPlainTextEmail(email: PlainTextEmail): Promise<void> {
  const { apiKey, from } = configuration();

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        // The key goes in a header and is never logged, never returned, and
        // never put in an error — see `EmailDeliveryError`.
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        // An array of exactly one. The API takes a list and this does not
        // offer one: a second recipient would be a product decision about who
        // may be told what, and nothing has made it.
        to: [email.to],
        subject: email.subject,
        // **`text` and no `html`.** A message with both would be two documents
        // to keep in step, and the one that renders is chosen by the reader's
        // client rather than by us.
        text: email.text,
      }),
      signal: AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
    });
  } catch (error) {
    // `AbortSignal.timeout` rejects with a `TimeoutError`; an abort from
    // anywhere else arrives as `AbortError`. Everything else that stops a
    // `fetch` before it has an answer is the network.
    const name = error instanceof Error ? error.name : "";
    throw new EmailDeliveryError(
      name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
    );
  }

  if (!response.ok) {
    // **The status and the body both stop here.** A provider's error body can
    // quote the message it was given, which is the account's material, and the
    // status alone is not something an operator can act on differently.
    throw new EmailDeliveryError("rejected");
  }

  // A success is documented as carrying the id of the message that was queued.
  // Reading it is not for the id — nothing here keeps one — but because a 2xx
  // whose body is not that shape means this is talking to something other than
  // the API it thinks it is, and reporting that as a delivery would be a lie
  // the reader has no way to check.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new EmailDeliveryError("unreadable");
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { id?: unknown }).id !== "string"
  ) {
    throw new EmailDeliveryError("unreadable");
  }
}
