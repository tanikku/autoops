import { promises as dns } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { isPublicUnicastAddress } from "@/lib/watcher/address";
import { WatcherError } from "@/lib/watcher/errors";

/**
 * Turns a host into the addresses it stands for.
 *
 * A seam rather than a call, so a test can say what a name resolves to without
 * a resolver, a network, or a fixture server. Nothing about safety lives here —
 * this reports what the system says, and the checking happens above it.
 */
export type AddressResolver = (hostname: string) => Promise<string[]>;

/**
 * The system's own answer, both families at once.
 *
 * `all` because a name with one bad address among several is the interesting
 * case, and asking for a single answer would hide it. `verbatim` keeps the
 * order the resolver gave rather than re-sorting by family, which matters only
 * because the first address is the one connected to.
 *
 * An address literal resolves to itself here, so a URL written as an IP goes
 * through exactly the same checks as a name.
 */
export const systemResolver: AddressResolver = async (hostname) => {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
};

/**
 * Resolves a host and refuses it unless every address it has is a public one.
 *
 * **One bad answer rejects the name.** Not "filter the private ones out and
 * connect to the rest" — a name that answers with both a public and a private
 * address is either misconfigured or deliberate, and in the deliberate case
 * filtering is precisely what the attacker is relying on: the connection would
 * be made, to the one address that got through, on a later attempt or a
 * different ordering. Refusing the whole name has no such second reading.
 *
 * A name that resolves to nothing is a resolution failure rather than an empty
 * success, for the same reason: "no addresses" must not fall through to code
 * that assumes there is one.
 *
 * The addresses come back so the caller can connect to *these* and not resolve
 * again — see `createPinnedLookup`.
 */
export async function resolveSafeAddresses(
  hostname: string,
  resolve: AddressResolver = systemResolver,
): Promise<string[]> {
  let addresses: string[];

  try {
    addresses = await resolve(hostname);
  } catch (error) {
    throw new WatcherError(
      "dns-failure",
      `Could not resolve ${hostname}.`,
      { cause: error },
    );
  }

  if (addresses.length === 0) {
    throw new WatcherError("dns-failure", `${hostname} resolved to nothing.`);
  }

  for (const address of addresses) {
    if (!isPublicUnicastAddress(address)) {
      // **The address is not in the message.** It is the one detail that would
      // turn a refusal into a probe: a caller who can tell "blocked" from "did
      // not resolve" learns whether a name points inside, and a caller who is
      // told which address learns the internal topology one guess at a time.
      throw new WatcherError(
        "blocked-address",
        `${hostname} resolves to an address AutoOps will not connect to.`,
      );
    }
  }

  return addresses;
}

/**
 * A resolver for the socket that does no resolution at all.
 *
 * **This is the whole of the rebinding defence.** Checking a name and then
 * handing the name to the socket leaves a gap: the socket resolves it a second
 * time, and the answer it gets is not required to be the answer that was
 * checked. A record with a one-second lifetime is enough — the first lookup
 * returns something public, the second returns `127.0.0.1`, and everything in
 * between was verified.
 *
 * Node lets a request supply its own `lookup`, and that function is what the
 * connection uses; there is no other resolution behind it. Handing it a fixed
 * list closes the gap by removing the second lookup entirely — **the addresses
 * connected to are the addresses that were checked, because there is nowhere
 * else for them to come from.** The hostname it is called with is ignored on
 * purpose.
 *
 * Both shapes of the callback are answered because both are used: Node asks for
 * every address when it is racing the families against each other, and for one
 * when it is not.
 */
export function createPinnedLookup(addresses: string[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(
        null,
        addresses.map((address) => ({
          address,
          family: familyOf(address),
        })),
      );
      return;
    }

    callback(null, addresses[0], familyOf(addresses[0]));
  };
}

/** 4 or 6, as Node's socket layer numbers them. */
function familyOf(address: string): number {
  return isIP(address);
}
