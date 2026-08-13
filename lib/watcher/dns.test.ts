import dnsModule from "node:dns";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createPinnedLookup,
  resolveSafeAddresses,
} from "@/lib/watcher/dns";
import { isWatcherError, type WatcherError } from "@/lib/watcher/errors";

/**
 * **A wall, not a stub.** Every test below supplies its own resolver, and this
 * is what catches one that does not: without it, a missing argument silently
 * asks the real resolver about a real name. Sprint 40 lost a test file to
 * exactly that shape — a lapsed replacement reaching the network unnoticed —
 * and the answer is the same one, a global that throws rather than works.
 */
const realLookup = dnsModule.promises.lookup;

dnsModule.promises.lookup = (() => {
  throw new Error("no DNS in tests");
}) as typeof dnsModule.promises.lookup;

afterAll(() => {
  dnsModule.promises.lookup = realLookup;
});

/** A resolver that answers with whatever the test says the name has. */
function resolverFor(addresses: string[]) {
  return vi.fn(async () => addresses);
}

async function kindOf(
  hostname: string,
  resolve: () => Promise<string[]>,
): Promise<string> {
  try {
    await resolveSafeAddresses(hostname, resolve);
  } catch (error) {
    return isWatcherError(error)
      ? (error as WatcherError).kind
      : "not-a-watcher-error";
  }

  return "resolved";
}

describe("resolving a name AutoOps may connect to", () => {
  it("returns the addresses when every one of them is public", async () => {
    const addresses = ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"];

    expect(await resolveSafeAddresses("example.com", resolverFor(addresses))).toEqual(
      addresses,
    );
  });

  it("asks the resolver for the host it was given", async () => {
    const resolve = resolverFor(["93.184.216.34"]);
    await resolveSafeAddresses("example.com", resolve);

    expect(resolve).toHaveBeenCalledWith("example.com");
  });
});

describe("resolving a name AutoOps refuses", () => {
  it("refuses a name that resolves to loopback", async () => {
    expect(await kindOf("localhost", resolverFor(["127.0.0.1"]))).toBe(
      "blocked-address",
    );
  });

  it("refuses a name that resolves into Railway's private network", async () => {
    // What a `*.railway.internal` name answers with: a unique-local IPv6
    // address, which is why IPv6 cannot be treated as an afterthought here.
    expect(await kindOf("postgres.railway.internal", resolverFor(["fd12:3456::1"]))).toBe(
      "blocked-address",
    );
  });

  it("refuses a name that resolves to the metadata address", async () => {
    expect(await kindOf("metadata.example", resolverFor(["169.254.169.254"]))).toBe(
      "blocked-address",
    );
  });

  /**
   * **The case the whole rule exists for.** A name answering with one public
   * address and one private one is either broken or aimed at us, and filtering
   * the private one out would connect anyway — to the address that got through,
   * this time. Refusing the name has no second reading.
   */
  it("refuses a name whose answers are only partly public", async () => {
    expect(
      await kindOf("mixed.example", resolverFor(["93.184.216.34", "10.0.0.5"])),
    ).toBe("blocked-address");
  });

  it("refuses it whichever order the answers arrive in", async () => {
    expect(
      await kindOf("mixed.example", resolverFor(["10.0.0.5", "93.184.216.34"])),
    ).toBe("blocked-address");
  });

  it("says nothing about which address it was", async () => {
    try {
      await resolveSafeAddresses("mixed.example", resolverFor(["10.0.0.5"]));
      expect.unreachable("should have been refused");
    } catch (error) {
      expect((error as Error).message).not.toContain("10.0.0.5");
    }
  });
});

describe("resolving a name that does not answer", () => {
  it("reports a resolution failure when the resolver throws", async () => {
    expect(
      await kindOf("nowhere.example", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).toBe("dns-failure");
  });

  it("reports one when the resolver answers with nothing", async () => {
    expect(await kindOf("empty.example", resolverFor([]))).toBe("dns-failure");
  });
});

/**
 * The rebinding defence, as far as a test can hold it.
 *
 * What it fixes is that **the lookup handed to the socket performs no
 * resolution**: it answers from the list it was built with, whatever it is
 * asked. That is the property that closes the gap between checking a name and
 * connecting to it — there is no second answer for a record to change into.
 *
 * What it cannot show is that Node's socket layer honours the function. That is
 * the contract of `lookup` in `http.request`, and it is verified by reading the
 * platform's own types rather than by exercising a connection here.
 */
describe("the lookup the connection uses", () => {
  const addresses = ["93.184.216.34", "2606:2800::1"];

  it("answers with the verified addresses, not with the name it was asked", () => {
    const lookup = createPinnedLookup(addresses);
    const callback = vi.fn();

    lookup("something-else.example", { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(null, [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800::1", family: 6 },
    ]);
  });

  it("answers a single-address request with the first of them", () => {
    const lookup = createPinnedLookup(addresses);
    const callback = vi.fn();

    lookup("something-else.example", {}, callback);

    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("never consults a resolver", () => {
    // The guard at the top of this file is the assertion: reaching DNS throws.
    const lookup = createPinnedLookup(["93.184.216.34"]);
    expect(() => lookup("example.com", { all: true }, vi.fn())).not.toThrow();
  });
});
