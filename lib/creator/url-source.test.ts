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
  extractCreatorSourceBody,
  isCreatorUrlSourceError,
  loadCreatorUrlSource,
  validateCreatorSourceUrl,
} = await import("@/lib/creator/url-source");
const { WatcherError } = await import("@/lib/watcher/errors");
const { creatorAnalysisLimits } = await import("@/lib/creator/analyzer");
const { normalizeWhitespace } = await import("@/lib/watcher/normalize");

/**
 * The real extractor, for the tests about *which part of a page* is read.
 *
 * The mock above stands in for it everywhere else, because those tests are
 * about the policy this module adds and a canned string is enough. Choosing a
 * container is different: what the choice is worth depends on what the shared
 * extractor makes of it, so these run against the real thing.
 */
const { extractDocumentText: realExtractDocumentText } = await vi.importActual<
  typeof import("@/lib/watcher/extract")
>("@/lib/watcher/extract");

/** Turns the mocked extractor back into the real one for one describe. */
function useRealExtractor(): void {
  mocks.extractDocumentText.mockImplementation((markup: string) =>
    realExtractDocumentText(markup),
  );
}

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

/**
 * Which part of a page is the piece being judged.
 *
 * **The case these exist for was measured in Production.** A real article
 * arrived with "投稿 ログイン 会員登録" in front of it and the site's footer
 * behind it, because the whole document was being handed over. The fixture
 * below is that shape, generalised.
 *
 * **Semantic HTML only, and exactly one of it.** Two `<article>` elements is a
 * page that has not said which one matters, and picking the first would be
 * inventing an answer — so the search moves on rather than guessing. There is
 * no length rule anywhere here: a short announcement is a legitimate source.
 */
describe("which part of the page is the source", () => {
  beforeEach(useRealExtractor);

  /**
   * The shape measured in Production, generalised — with a sentence of its own
   * outside the article, so that "the main was chosen" and "the article was
   * chosen" are different answers rather than the same string.
   */
  const NOTE_LIKE = `<html>
<head><title>AIに… | note公式</title></head>
<body>
<nav>投稿 ログイン 会員登録</nav>
<main>
  <p>公式からのお知らせ</p>
  <article>
    <h1>AIにプロフィールが伝わるしくみ</h1>
    <p>なにかを調べたりするとき、</p>
    <p>そのしくみを導入しました。</p>
  </article>
</main>
<footer>利用規約 お問い合わせ</footer>
</body>
</html>`;

  it("takes the content out of a page wrapped in site chrome", () => {
    const body = extractCreatorSourceBody(NOTE_LIKE);

    expect(body).toContain("AIにプロフィールが伝わるしくみ");
    expect(body).toContain("なにかを調べたりするとき、");
    expect(body).toContain("そのしくみを導入しました。");
  });

  it.each(["投稿", "ログイン", "会員登録", "利用規約", "お問い合わせ"])(
    "leaves %o out of it",
    (chrome) => {
      expect(extractCreatorSourceBody(NOTE_LIKE)).not.toContain(chrome);
    },
  );

  /**
   * **The main is the piece, not the article inside it.**
   *
   * `<main>` is the page saying where its primary content is. `<article>` says
   * only that something is self-contained — which a related-post card, a
   * recommendation and a sidebar entry all are. The sentence outside the
   * article is what makes this assertion mean something: an article-first
   * selection would drop it.
   */
  it("takes the whole main, not the article inside it", () => {
    const body = extractCreatorSourceBody(NOTE_LIKE);

    expect(body).toContain("公式からのお知らせ");
    expect(body).toBe(
      "公式からのお知らせ AIにプロフィールが伝わるしくみ なにかを調べたりするとき、 そのしくみを導入しました。",
    );
  });

  it("keeps the main even when the article is all that is in it", () => {
    const html = `<html><body><nav>Nav</nav><main><article><p>The piece</p></article></main></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("The piece");
  });

  it("takes a lone article when there is no main at all", () => {
    const html = `<html><body><nav>Nav</nav><article><p>The piece</p></article></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("The piece");
  });

  /**
   * **What counts as text inside the candidate is the shared extractor's
   * answer**, not a second copy of it living here.
   */
  it("drops what is not text, by the rules the whole product uses", () => {
    const html = `<html><body><main><script>var a = 1;</script><style>p{}</style><p>Kept</p></main></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("Kept");
  });

  it("collapses the whitespace the markup was written with", () => {
    const html = `<html><body><main>
      <p>One</p>

      <p>two   three</p>
    </main></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("One two three");
  });

  /** A page that says where its content is, and says "nowhere". */
  it("moves on from a main with nothing in it", () => {
    const html = `<html><body><main><img src="x.png"></main><article><p>The piece</p></article></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("The piece");
  });
});

/**
 * Where a candidate sits decides whether it may stand for the page.
 *
 * **Every case here is a regression an audit found in the first version.** It
 * preferred `<article>` and looked only at the tag name, so a related-post
 * teaser in an `<aside>`, a link list in a `<nav>`, a footer entry, and an
 * article inside `<div hidden>` each replaced the visible content of the page —
 * which is strictly worse than reading the whole document, because the real
 * content was in that and is not in these.
 *
 * **Serialising is why the check has to happen here.** The fragment handed to
 * the shared extractor starts at the candidate, so nothing downstream can see
 * that an ancestor was hidden.
 */
describe("where a candidate may not stand for the page", () => {
  beforeEach(useRealExtractor);

  it.each([
    ["an aside", "aside", "RELATED ARTICLE"],
    ["a nav", "nav", "NAV ARTICLE"],
    ["a footer", "footer", "FOOTER ARTICLE"],
    ["a header", "header", "HEADER ARTICLE"],
  ])("ignores an article inside %s", (_name, tag, text) => {
    const html = `<html><body><${tag}><article>${text}</article></${tag}><main>PRIMARY CONTENT</main></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("PRIMARY CONTENT");
  });

  it("ignores an article under a hidden ancestor", () => {
    const html = `<html><body><div hidden><article>HIDDEN ARTICLE</article></div><main>PRIMARY CONTENT</main></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("PRIMARY CONTENT");
  });

  it("ignores a hidden article itself", () => {
    const html = `<html><body><article hidden>HIDDEN ARTICLE</article><main>PRIMARY CONTENT</main></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("PRIMARY CONTENT");
  });

  /** A hidden main is no more the page than a hidden article is. */
  it("ignores a main under a hidden ancestor and falls to the article", () => {
    const html = `<html><body><div hidden><main>HIDDEN MAIN</main></div><article>VISIBLE ARTICLE</article></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("VISIBLE ARTICLE");
  });

  it("ignores a hidden main itself", () => {
    const html = `<html><body><main hidden>HIDDEN MAIN</main><article>VISIBLE ARTICLE</article></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("VISIBLE ARTICLE");
  });

  /**
   * **An ineligible one does not make the page ambiguous either.** A site with
   * one real article and one in its footer has said where its content is
   * exactly once.
   */
  it("does not count an ineligible article towards the cardinality", () => {
    const html = `<html><body><footer><article>FOOTER ARTICLE</article></footer><article>THE PIECE</article></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("THE PIECE");
  });

  /**
   * **`<main>` inside an `<aside>` is not the page's main either.** The rule is
   * about where a candidate sits, and it does not care which of the two tags
   * the candidate is.
   */
  it("ignores a main inside an aside", () => {
    const html = `<html><body><aside><main>ASIDE MAIN</main></aside><article>THE PIECE</article></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("THE PIECE");
  });

  /**
   * **A hidden `<body>` hides the page, and the selection may not step over
   * it.** The shared extractor already reads nothing from one; a candidate
   * rescued out of it would be text the markup says is not being shown,
   * arriving at the model because Koqentra reached past the answer the page
   * gave. Serialising the candidate is exactly what would lose that, which is
   * why the boundary is checked here.
   */
  it("reads nothing at all from a hidden body", () => {
    const html = `<html><body hidden><main>HIDDEN MAIN</main></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("");
    expect(extractCreatorSourceBody(html)).toBe(
      normalizeWhitespace(realExtractDocumentText(html)),
    );
  });

  it("reads nothing from a hidden body holding an article either", () => {
    const html = `<html><body hidden><article>HIDDEN ARTICLE</article></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("");
  });

  /**
   * **The same boundary one level higher.** A hidden `<html>` hides everything,
   * and the shared extractor reads nothing from one — so a candidate lifted out
   * of it would be text the markup says is not being shown. Serialising the
   * candidate is what loses that, exactly as it does for a hidden `<body>`.
   */
  it("reads nothing at all from a hidden html element", () => {
    const html = `<html hidden><body><main>HIDDEN MAIN</main></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("");
    expect(extractCreatorSourceBody(html)).toBe(
      normalizeWhitespace(realExtractDocumentText(html)),
    );
  });

  it("reads nothing from a hidden html element holding an article either", () => {
    const html = `<html hidden><body><article>HIDDEN ARTICLE</article></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("");
    expect(extractCreatorSourceBody(html)).toBe(
      normalizeWhitespace(realExtractDocumentText(html)),
    );
  });

  /**
   * **Markup that is present but not being shown.** parse5 does not put these
   * subtrees where an element walk would find them — a `<template>`'s contents
   * live in a fragment of their own, and `<noscript>` and `<iframe>` contents
   * parse as text — so what is fixed here is the outcome rather than the
   * mechanism.
   */
  it.each(["template", "noscript", "iframe"])(
    "never takes an article inside %s",
    (tag) => {
      const html = `<html><body><${tag}><article>NOT SHOWN</article></${tag}><main>PRIMARY CONTENT</main></body></html>`;

      expect(extractCreatorSourceBody(html)).toBe("PRIMARY CONTENT");
    },
  );
});

describe("a page that is hidden at its root", () => {
  it.each([
    ["a hidden body", `<html><body hidden><main>HIDDEN MAIN</main></body></html>`],
    ["a hidden html", `<html hidden><body><main>HIDDEN MAIN</main></body></html>`],
  ])("is refused as a source with %s, exactly as an empty page is", async (_name, content) => {
    useRealExtractor();
    mocks.decodeWebsiteContent.mockReturnValue({
      content,
      mediaType: "text/html",
    });

    expect(await failureOf(loadCreatorUrlSource(URL_IN))).toBe("empty");
  });
});

describe("falling back to the article", () => {
  beforeEach(useRealExtractor);

  it("takes the article when the page names no main", () => {
    const html = `<html><body><nav>Nav</nav><article><p>The piece</p></article><footer>Footer</footer></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("The piece");
  });

  /**
   * **Two mains is a page that has not said which one matters.** The search
   * moves on rather than choosing, and an article outside every excluded
   * context is an answer the page did give.
   */
  it("takes a lone article when the page names two mains", () => {
    const html = `<html><body><main><p>A</p></main><main><p>B</p></main><article><p>The piece</p></article></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("The piece");
  });

  /**
   * **A related post inside the main stays there.** The main is the boundary
   * the page drew, and reaching inside it to prune would be the heuristic this
   * checkpoint exists to avoid. Removing site chrome is the goal; perfect
   * article extraction is not.
   */
  it("keeps what the page put inside its own main", () => {
    const html = `<html><body><nav>Nav</nav><main><p>PRIMARY CONTENT</p><aside><article>RELATED ARTICLE</article></aside></main></body></html>`;

    const body = extractCreatorSourceBody(html);

    expect(body).toBe("PRIMARY CONTENT RELATED ARTICLE");
    expect(body).not.toContain("Nav");
  });

  it("gives the whole document when the lone article is empty", () => {
    const html = `<html><body><nav>Nav</nav><article></article><p>Loose text</p></body></html>`;

    expect(extractCreatorSourceBody(html)).toBe("Nav Loose text");
  });
});

/**
 * **The answer the product gave before any of this existed.** Every route out
 * of the selection ends here, so a page that could be read yesterday reads the
 * same today.
 */
describe("falling back to the whole document", () => {
  beforeEach(useRealExtractor);

  const documentText = (html: string) =>
    normalizeWhitespace(realExtractDocumentText(html));

  it.each([
    [
      "a page that names neither",
      `<html><body><nav>Nav</nav><p>Loose text</p><footer>Footer</footer></body></html>`,
    ],
    [
      "several articles and no main",
      `<html><body><article><p>A</p></article><article><p>B</p></article></body></html>`,
    ],
    [
      "several mains",
      `<html><body><main><p>A</p></main><main><p>B</p></main></body></html>`,
    ],
    [
      "several of both",
      `<html><body><main><article><p>A</p></article></main><main><article><p>B</p></article></main></body></html>`,
    ],
  ])("gives the whole document for %s", (_name, html) => {
    expect(extractCreatorSourceBody(html)).toBe(documentText(html));
  });

  it("changes nothing about a page with no markup to speak of", () => {
    const html = "Just some text.";

    expect(extractCreatorSourceBody(html)).toBe(documentText(html));
  });
});

/**
 * **The improvement that makes a page analysable at all.** A document whose
 * navigation and footer push it past the ceiling can still have an article
 * comfortably inside it — and that article is what somebody asked about.
 */
describe("a page that is only too large with its chrome attached", () => {
  const article = "A sentence about the subject. ".repeat(200);
  const chrome = "Nav link. ".repeat(4_000);

  const html = `<html><body><nav>${chrome}</nav><article><p>${article}</p></article><footer>${chrome}</footer></body></html>`;

  beforeEach(useRealExtractor);

  it("is over the ceiling as a whole document", () => {
    expect(
      normalizeWhitespace(realExtractDocumentText(html)).length,
    ).toBeGreaterThan(creatorAnalysisLimits.contentBody);
  });

  it("is under it once the article is what is read", () => {
    expect(extractCreatorSourceBody(html).length).toBeLessThanOrEqual(
      creatorAnalysisLimits.contentBody,
    );
  });

  it("is accepted as a source rather than refused", async () => {
    mocks.decodeWebsiteContent.mockReturnValue({
      content: html,
      mediaType: "text/html",
    });
    mocks.extractDocumentText.mockImplementation((markup: string) =>
      realExtractDocumentText(markup),
    );

    const source = await loadCreatorUrlSource(URL_IN);

    expect(source.body).toContain("A sentence about the subject.");
    expect(source.body).not.toContain("Nav link.");
  });
});

/**
 * **An article larger than an analysis may carry is still the article.**
 * Falling back to the whole document because the chosen part was too big would
 * hand the model *more* text and call it a rescue.
 */
describe("an article larger than the ceiling", () => {
  beforeEach(useRealExtractor);

  it("is refused rather than swapped for the whole document", async () => {
    const article = "x".repeat(creatorAnalysisLimits.contentBody + 1);
    const html = `<html><body><nav>Nav</nav><article><p>${article}</p></article></body></html>`;

    mocks.decodeWebsiteContent.mockReturnValue({
      content: html,
      mediaType: "text/html",
    });
    mocks.extractDocumentText.mockImplementation((markup: string) =>
      realExtractDocumentText(markup),
    );

    expect(await failureOf(loadCreatorUrlSource(URL_IN))).toBe("too-large");
  });
});
