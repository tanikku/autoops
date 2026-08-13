/**
 * Every bound a fetch is held to, in one place.
 *
 * They are here rather than beside the code that enforces them because each one
 * is a decision someone has to be able to find and argue with, and because a
 * limit that appears twice is a limit that will be raised once.
 *
 * **None of them is configurable yet.** Making them so means deciding who may
 * change them — a worker's owner, or whoever operates the platform — and that
 * is a product question rather than a fetch question. Keeping them together is
 * what makes answering it later a small change.
 */

/**
 * How long one call has, from the first name resolution to the last byte.
 *
 * **A budget across every redirect, not a timeout per request.** A per-hop
 * timeout multiplies: three redirects at ten seconds each is forty seconds for
 * one worker, and nothing in the tick would say so. One budget means the answer
 * to "how long can this take" is this number, whatever the origin does with it.
 *
 * Twenty seconds is far more than an ordinary HTML page needs — most arrive in
 * under two — and it is 3% of the ten minutes the model provider is given, so a
 * worker that also fetches is still dominated by the time it spends generating.
 */
export const FETCH_BUDGET_MS = 20_000;

/**
 * How many redirects are followed before giving up.
 *
 * Three covers the chains that occur in practice and are all canonicalisation
 * rather than indirection: `http` to `https`, apex to `www`, and a missing
 * trailing slash. A fourth hop is a site doing something else, and a loop is
 * caught by the same limit rather than by detecting the loop — a cycle and a
 * long chain both end here, and neither needs a separate rule.
 */
export const MAX_REDIRECTS = 3;

/**
 * How much of a response body is read before it is refused.
 *
 * **Enforced while reading, not after.** A limit checked against
 * `content-length` protects nothing: the header is the origin's claim, and a
 * body that never ends carries no header at all.
 *
 * Two megabytes is roughly twenty times a large HTML document. It is set by
 * what has to be held in memory rather than by what is polite to download —
 * this runs inside a request handler on a shared instance, and the ceiling is
 * per fetch.
 */
export const MAX_RESPONSE_BYTES = 2_000_000;

/**
 * What AutoOps calls itself when it asks for a page.
 *
 * Identifiable on purpose. An operator reading their own logs should be able to
 * tell what this is and where to complain about it, and a repository URL says
 * both without naming a deployment or anyone's account.
 */
export const USER_AGENT =
  "AutoOpsWatcher/1.0 (+https://github.com/tanikku/autoops)";
