import { describe, expect, it } from "vitest";
import { isPublicUnicastAddress } from "@/lib/watcher/address";

/**
 * Which addresses AutoOps will open a connection to.
 *
 * **The table below is the security boundary**, so it is written as addresses
 * rather than as ranges: a test that restated the prefixes would agree with the
 * implementation by construction and prove nothing. Each of these is somewhere
 * a URL could point, and the answer is whether a socket may go there.
 *
 * Nothing here touches the network — classifying an address is arithmetic.
 */

describe("addresses AutoOps refuses to connect to", () => {
  const refused: [string, string][] = [
    ["127.0.0.1", "loopback"],
    ["127.9.9.9", "the rest of loopback, which is a /8 and not one address"],
    ["10.0.0.1", "private, RFC 1918"],
    ["172.16.0.1", "private, the bottom of the /12"],
    ["172.31.255.255", "private, the top of the /12"],
    ["192.168.1.1", "private"],
    ["169.254.1.1", "link-local"],
    ["169.254.169.254", "the address cloud metadata answers on"],
    ["0.0.0.0", "unspecified"],
    ["0.0.0.1", "the rest of the unspecified /8"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["198.18.0.1", "benchmarking, reserved"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fc00::1", "unique local, the bottom of fc00::/7"],
    ["fd00::1", "unique local — what Railway's private network answers with"],
    ["fe80::1", "IPv6 link-local"],
    ["ff02::1", "IPv6 multicast"],
    ["2001:db8::1", "documentation, reserved"],
    ["::ffff:127.0.0.1", "loopback written as an IPv4-mapped IPv6 address"],
    ["::ffff:10.0.0.1", "private, written the same way"],
    ["::ffff:169.254.169.254", "metadata, written the same way"],
    ["2002::1", "6to4, which embeds an IPv4 address this cannot see through"],
    ["not-an-address", "not an address at all"],
    ["", "nothing"],
  ];

  it.each(refused)("refuses %s — %s", (address) => {
    expect(isPublicUnicastAddress(address)).toBe(false);
  });
});

describe("addresses AutoOps will connect to", () => {
  const allowed: [string, string][] = [
    ["93.184.216.34", "an ordinary public IPv4 address"],
    ["8.8.8.8", "another"],
    ["172.32.0.1", "just above the private /12, and so public"],
    ["172.15.255.255", "just below it"],
    ["2606:2800:220:1:248:1893:25c8:1946", "an ordinary public IPv6 address"],
    ["::ffff:93.184.216.34", "a public IPv4 address written as mapped IPv6"],
  ];

  it.each(allowed)("allows %s — %s", (address) => {
    expect(isPublicUnicastAddress(address)).toBe(true);
  });
});

/**
 * The classification comes from `ipaddr.js`, and this is the reason to trust it
 * rather than a hand-written list: the ranges it knows about are wider than the
 * ones anybody would have thought to write down.
 *
 * **It is an allowlist of one name.** Anything the library sorts into a range
 * that is not `unicast` is refused, including ranges added to the library after
 * this was written — which is the direction a security check should fail in.
 */
describe("the shape of the rule", () => {
  it("refuses a range nobody here enumerated", () => {
    // Segment routing, RFC 9602. Not named anywhere in AutoOps, and refused
    // because it is not `unicast` rather than because it was listed.
    expect(isPublicUnicastAddress("5f00::1")).toBe(false);
  });
});
