import ipaddr from "ipaddr.js";

/**
 * Whether AutoOps may open a connection to this address.
 *
 * **An allowlist of one range, not a list of the ranges to avoid.** Both IPv4
 * and IPv6 sort every address into a named range, and exactly one of those
 * names — `unicast` — means "an ordinary address on the public internet".
 * Everything else is loopback, private, link-local, unique-local, multicast,
 * unspecified, carrier-grade NAT, or reserved, and none of those is a place a
 * user's worker has any business reaching.
 *
 * The direction is the point. A blocklist is a list somebody has to remember to
 * add to: the day a range is delegated, or the day this runs somewhere with a
 * private range nobody here has heard of, a blocklist quietly starts allowing
 * it. This refuses anything it has not been told is ordinary.
 *
 * **The classification is `ipaddr.js`'s, not ours.** Writing the ranges out by
 * hand is where this would go wrong — IPv6 alone has a dozen of them, and the
 * cost of getting one prefix length wrong is the whole of what this function
 * exists to prevent.
 *
 * **IPv4-mapped IPv6 is unwrapped and asked again.** `::ffff:127.0.0.1` is a
 * loopback address written the long way round; the library names that shape
 * `ipv4Mapped` rather than looking through it, so this looks through it. Any
 * other kind of embedded IPv4 — `6to4`, `teredo`, the RFC 6052 forms — is
 * simply not `unicast` and stops here.
 *
 * What it does not do is decide whether the *name* was acceptable. This takes
 * an address, and the caller is responsible for it being one the connection
 * will actually use.
 */
export function isPublicUnicastAddress(address: string): boolean {
  let parsed;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    // Not an address at all. Refusing is the only safe reading: a caller that
    // reaches here with a hostname must not have it treated as reachable.
    return false;
  }

  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return isPublicUnicastAddress(v6.toIPv4Address().toString());
    }
  }

  return parsed.range() === "unicast";
}
