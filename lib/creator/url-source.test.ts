import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reading a public page so that a piece of writing can be judged.
 *
 * **No network, ever.** The fetch boundary is replaced, so what is fixed here
 * is the policy this module adds on top of it: that the platform's throttle is
 * the one used, that the address the body came from is the one returned, and
 * that a fetch-layer failure becomes a category a reader can act on without
 * carrying a host, a status or a charset out with it.
 *
 * **What is deliberately not tested here is the safety itself.** Which
 * addresses may be reached, what happens at each redirect and how many bytes
 * may arrive are `lib/watcher`'s, tested there, and unchanged by this
 * checkpoint. A second set of assertions about them here would be a second
 * place to update when they move.
 */

const mocks = vi.hoisted(() => ({
  fetchWatchedPage: vi.fn(),
  decodeWebsiteContent: vi.fn(),
  extractDocumentText: vi.fn(),
  acquireWebsiteDomainThrottle: vi.fn(),
}));

vi.mock("@/lib/watcher/fetch", () => ({
  fetchWatchedPage: mocks.fetchWatchedPage,
}));
vi.mock("@/lib/watcher/decode", () => ({
  decodeWebsiteContent: mocks.decodeWebsiteContent,
}));
vi.mock("@/lib/watcher/extract", () => ({
  extractDocumentText: mocks.extractDocumentText,
}));
vi.mock("@/lib/website-throttle", () => ({
  acquireWebsiteDomainThrottle: mocks.acquireWebsiteDomainThrottle,
}));

const {
  CreatorUrlSourceError,
  extractCreatorPageTitle,
  isCreatorUrlSourceError,
  loadCreatorUrlSource,
  validateCreatorSourceUrl,
} = await import("@/lib/creator/url-source");
const { WatcherError } = await import("@/lib/watcher/errors");
const { creatorAnalysisLimits } = await import("@/lib/creator/analyzer");

const URL_IN = "https://example.com/article";

function page(overrides: Record<string, unknown> = {}) {
  return {
    url: URL_IN,
    status: 200,
    contentType: "html",
    contentTypeHeader: "text/html; charset=utf-8",
    body: new Uint8Array([1, 2, 3]),
    byteLength: 3,
    ...overrides,
  };
}

/** The failure a rejection carries, or the rejection itself if it is not one. */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );

  return isCreatorUrlSourceError(error) ? error.failure : error;
}

beforeEach(() => {
  mocks.fetchWatchedPage.mockReset().mockResolvedValue(page());
  mocks.decodeWebsiteContent
    .mockReset()
    .mockReturnValue({ content: "<p>Hello</p>", mediaType: "text/html" });
  mocks.extractDocumentText.mockReset().mockReturnValue("  Hello   there \n");
  mocks.acquireWebsiteDomainThrottle.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("refusing an address without touching the network", () => {
  it.each(["", "   "])("refuses %o as an address", (raw) => {
    expect(() => validateCreatorSourceUrl(raw)).toThrow(CreatorUrlSourceError);
    expect(mocks.fetchWatchedPage).not.toHaveBeenCalled();
  });

  /**
   * The rules are `parseWatchUrl`'s, so this checks that they are applied
   * rather than restating them — a copy here would be a second policy to
   * maintain.
   */
  it.each([
    ["not-a-url", "malformed"],
    ["ftp://example.com/a", "an unsupported scheme"],
    ["https://example.com:8443/a", "a port"],
    ["https://user:pass@example.com/a", "credentials"],
  ])("refuses %o — %s", async (raw) => {
    expect(() => validateCreatorSourceUrl(raw)).toThrow(CreatorUrlSourceError);
    expect(await failureOf(loadCreatorUrlSource(raw))).toBe("invalid-url");
    expect(mocks.fetchWatchedPage).not.toHaveBeenCalled();
  });

  it("refuses an address longer than an analysis may carry", async () => {
    const long = `https://example.com/${"a".repeat(
      creatorAnalysisLimits.contentSourceUrl,
    )}`;

    expect(await failureOf(loadCreatorUrlSource(long))).toBe("invalid-url");
    expect(mocks.fetchWatchedPage).not.toHaveBeenCalled();
  });

  it("accepts an ordinary public address", () => {
    expect(() => validateCreatorSourceUrl(URL_IN)).not.toThrow();
  });
});

describe("how the page is fetched", () => {
  it("asks the shared fetch boundary rather than the network", async () => {
    await loadCreatorUrlSource(URL_IN);

    expect(mocks.fetchWatchedPage).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWatchedPage.mock.calls[0][0]).toBe(URL_IN);
  });

  /**
   * **The platform's politeness, not this feature's.** A Creator analysis and a
   * Website Worker pointed at the same host are two requests from the same
   * deployment, and `fetchWatchedPage`'s default allows everything.
   */
  it("uses the platform-wide domain throttle", async () => {
    await loadCreatorUrlSource(URL_IN);

    expect(mocks.fetchWatchedPage.mock.calls[0][1].throttle).toBe(
      mocks.acquireWebsiteDomainThrottle,
    );
  });

  it("decodes and extracts through the shared primitives", async () => {
    await loadCreatorUrlSource(URL_IN);

    expect(mocks.decodeWebsiteContent).toHaveBeenCalledWith(
      expect.anything(),
      "text/html; charset=utf-8",
    );
    expect(mocks.extractDocumentText).toHaveBeenCalledWith("<p>Hello</p>");
  });

  /** A redirect means the page read is not the page asked for. */
  it("returns the address the body actually came from", async () => {
    mocks.fetchWatchedPage.mockResolvedValue(
      page({ url: "https://www.example.com/article/" }),
    );

    await expect(loadCreatorUrlSource(URL_IN)).resolves.toEqual({
      sourceUrl: "https://www.example.com/article/",
      body: "Hello there",
      // The fixture markup names no title; C1.9B added the field, not a value.
      pageTitle: null,
    });
  });

  it("normalises the whitespace it found", async () => {
    mocks.extractDocumentText.mockReturnValue("One\n\n  two\tthree  ");

    const source = await loadCreatorUrlSource(URL_IN);

    expect(source.body).toBe("One two three");
  });
});

describe("what cannot become a source", () => {
  it("refuses a page with no readable text", async () => {
    mocks.extractDocumentText.mockReturnValue("   \n  ");

    expect(await failureOf(loadCreatorUrlSource(URL_IN))).toBe("empty");
  });

  /**
   * **Refused rather than cut.** The Creator contract is that the piece being
   * judged is the piece that was submitted; an address is not a reason to start
   * trimming somebody's material.
   */
  it("refuses a page longer than an analysis may carry", async () => {
    mocks.extractDocumentText.mockReturnValue(
      "x".repeat(creatorAnalysisLimits.contentBody + 1),
    );

    expect(await failureOf(loadCreatorUrlSource(URL_IN))).toBe("too-large");
  });

  it("accepts a page exactly at the ceiling", async () => {
    mocks.extractDocumentText.mockReturnValue(
      "x".repeat(creatorAnalysisLimits.contentBody),
    );

    await expect(loadCreatorUrlSource(URL_IN)).resolves.toMatchObject({
      body: "x".repeat(creatorAnalysisLimits.contentBody),
    });
  });

  /** A redirect chain can end somewhere too long to store. */
  it("refuses a final address longer than the limit", async () => {
    mocks.fetchWatchedPage.mockResolvedValue(
      page({
        url: `https://example.com/${"a".repeat(
          creatorAnalysisLimits.contentSourceUrl,
        )}`,
      }),
    );

    expect(await failureOf(loadCreatorUrlSource(URL_IN))).toBe("invalid-url");
  });
});

/**
 * **Seventeen kinds become six situations.** The fetch vocabulary tells an
 * operator what happened at the socket; a reader needs to know what to do next,
 * and there is nothing different to do about a DNS failure and a 503.
 */
describe("what a reader is told went wrong", () => {
  it.each([
    ["invalid-url", "invalid-url"],
    ["unsupported-scheme", "invalid-url"],
    ["unsupported-port", "invalid-url"],
    ["blocked-address", "blocked"],
    ["insecure-redirect", "blocked"],
    ["dns-failure", "unavailable"],
    ["connect-failure", "unavailable"],
    ["timeout", "unavailable"],
    ["throttled", "unavailable"],
    ["redirect-limit", "unavailable"],
    ["http-error", "unavailable"],
    ["response-too-large", "too-large"],
    ["unsupported-content-type", "unreadable"],
    ["unsupported-charset", "unreadable"],
    ["invalid-encoding", "unreadable"],
    ["encoding-conflict", "unreadable"],
    ["normalization-failed", "unreadable"],
  ] as const)("reads %s as %s", async (kind, failure) => {
    mocks.fetchWatchedPage.mockRejectedValue(
      new WatcherError(kind, "SECRET DIAGNOSTIC DETAIL"),
    );

    expect(await failureOf(loadCreatorUrlSource(URL_IN))).toBe(failure);
  });

  it("maps a failure raised while decoding too", async () => {
    mocks.decodeWebsiteContent.mockImplementation(() => {
      throw new WatcherError("unsupported-content-type", "SECRET DETAIL");
    });

    expect(await failureOf(loadCreatorUrlSource(URL_IN))).toBe("unreadable");
  });

  /**
   * **Nothing about the page or the address leaves here.** The `WatcherError`
   * can name a host, a status or a charset, and the URL is somebody's browsing.
   */
  it("carries none of the diagnostic out with it", async () => {
    mocks.fetchWatchedPage.mockRejectedValue(
      new WatcherError("http-error", `SECRET 503 from ${URL_IN}`),
    );

    const error = await loadCreatorUrlSource(URL_IN).catch((thrown) => thrown);

    expect(isCreatorUrlSourceError(error)).toBe(true);
    expect(error.message).not.toContain("SECRET");
    expect(error.message).not.toContain("example.com");
    expect(error.cause).toBeUndefined();
  });

  it("logs the kind and nothing else", async () => {
    mocks.fetchWatchedPage.mockRejectedValue(
      new WatcherError("http-error", `SECRET 503 from ${URL_IN}`),
    );

    await loadCreatorUrlSource(URL_IN).catch(() => {});

    const logged = JSON.stringify(
      (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls,
    );

    expect(logged).toContain("http-error");
    expect(logged).not.toContain("SECRET");
    expect(logged).not.toContain("example.com");
  });

  /** A fault on Koqentra's own side is not a page problem, and stays itself. */
  it("lets something that is not a fetch failure through", async () => {
    const boom = new Error("something else entirely");
    mocks.fetchWatchedPage.mockRejectedValue(boom);

    await expect(loadCreatorUrlSource(URL_IN)).rejects.toBe(boom);
  });
});

/**
 * What a page calls itself, when the box was left empty.
 *
 * **`<title>` and nothing else.** It is the one name a document states about
 * itself; `og:title` and `h1` are guesses at what an *article* is called, and
 * guessing that well is a different problem.
 *
 * **Parsed rather than matched**, which is what makes the entity case work — a
 * regular expression over markup would hand back `A &amp; B`.
 */
describe("what the page calls itself", () => {
  const withTitle = (title: string) =>
    `<!doctype html><html><head><title>${title}</title></head><body><p>Hi</p></body></html>`;

  it("reads the title out of the document", () => {
    expect(extractCreatorPageTitle(withTitle("Privacy — Koqentra"))).toBe(
      "Privacy — Koqentra",
    );
  });

  it("decodes entities the way a browser would", () => {
    expect(extractCreatorPageTitle(withTitle("A &amp; B"))).toBe("A & B");
  });

  it("collapses the whitespace a formatter left in it", () => {
    expect(
      extractCreatorPageTitle(
        "<html><head><title>\n  Privacy   —   Koqentra\n</title></head><body></body></html>",
      ),
    ).toBe("Privacy — Koqentra");
  });

  it.each([
    ["no title at all", "<html><head></head><body><p>Hi</p></body></html>"],
    ["an empty title", "<html><head><title></title></head><body></body></html>"],
    [
      "a title of only whitespace",
      "<html><head><title>   \n </title></head><body></body></html>",
    ],
  ])("says nothing for %s", (_name, html) => {
    expect(extractCreatorPageTitle(html)).toBeNull();
  });

  it("keeps a title exactly at the limit", () => {
    const title = "T".repeat(creatorAnalysisLimits.contentTitle);

    expect(extractCreatorPageTitle(withTitle(title))).toBe(title);
  });

  /**
   * **Dropped rather than cut.** The Creator contract refuses an oversized
   * title rather than trimming one, and an automatic convenience is the last
   * place to start rewriting somebody's material. Refusing the whole analysis
   * would be worse: the page is fine and only this optional extra is not.
   */
  it("drops a title past the limit rather than shortening it", () => {
    const title = "T".repeat(creatorAnalysisLimits.contentTitle + 1);

    expect(extractCreatorPageTitle(withTitle(title))).toBeNull();
  });

  it("finds a title the parser had to move", () => {
    expect(
      extractCreatorPageTitle("<title>Bare title</title><p>Body</p>"),
    ).toBe("Bare title");
  });
});

describe("the page title on a loaded source", () => {
  const HTML =
    "<html><head><title>Privacy — Koqentra</title></head><body><p>Hello</p></body></html>";

  it("comes back alongside the address and the text", async () => {
    mocks.decodeWebsiteContent.mockReturnValue({
      content: HTML,
      mediaType: "text/html",
    });
    mocks.extractDocumentText.mockReturnValue("Privacy — Koqentra Hello");

    await expect(loadCreatorUrlSource(URL_IN)).resolves.toEqual({
      sourceUrl: URL_IN,
      body: "Privacy — Koqentra Hello",
      pageTitle: "Privacy — Koqentra",
    });
  });

  it("is null when the page names itself nothing", async () => {
    mocks.decodeWebsiteContent.mockReturnValue({
      content: "<html><head></head><body><p>Hello</p></body></html>",
      mediaType: "text/html",
    });

    const source = await loadCreatorUrlSource(URL_IN);

    expect(source.pageTitle).toBeNull();
  });

  /**
   * **The body did not change in this checkpoint.** `extractDocumentText`
   * already takes the title out of `head`, and what the analyzer is given to
   * judge is exactly what C1.9A verified in Production.
   */
  it("changes neither the text nor the address", async () => {
    mocks.decodeWebsiteContent.mockReturnValue({
      content: HTML,
      mediaType: "text/html",
    });
    mocks.fetchWatchedPage.mockResolvedValue(
      page({ url: "https://www.example.com/article/" }),
    );

    const source = await loadCreatorUrlSource(URL_IN);

    expect(mocks.extractDocumentText).toHaveBeenCalledWith(HTML);
    expect(source.body).toBe("Hello there");
    expect(source.sourceUrl).toBe("https://www.example.com/article/");
  });

  /** Reading a title is not a reason to ask for the page a second time. */
  it("asks for the page once", async () => {
    await loadCreatorUrlSource(URL_IN);

    expect(mocks.fetchWatchedPage).toHaveBeenCalledTimes(1);
  });
});
