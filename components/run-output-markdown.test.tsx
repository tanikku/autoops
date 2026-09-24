import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunOutputMarkdown } from "@/components/run-output-markdown";

/**
 * What a model's answer becomes on the screen, and what it never becomes.
 *
 * **Two properties, and the second is the important one.** A heading should be
 * a heading and a table should be a table — but the output came from a model
 * that was shown a page somebody else controls, so nothing in it may execute.
 * The malicious samples below are held apart from the readable one on purpose:
 * they are the reason this component exists as a boundary rather than as a
 * call in the page.
 *
 * **The fixtures are synthetic.** An example hotel on `example.test`, with no
 * real booking anywhere in them.
 */

/** The markup the renderer produced, exactly as it would be served. */
function html(markdown: string): string {
  return renderToStaticMarkup(<RunOutputMarkdown>{markdown}</RunOutputMarkdown>);
}

/** The readable text, for assertions about content rather than structure. */
function text(markdown: string): string {
  return html(markdown)
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A watcher's answer about a hotel, of the shape that prompted this work:
 * headings, emphasis, a GFM table and a list, with one safe link.
 */
const HOTEL_OUTPUT = `# Hotel availability change

## Newly available rooms

**Newly available**

| Plan | Room | Price | Availability |
| --- | --- | ---: | --- |
| Standard | Double | ¥15,000 | 11+ |
| Standard | Twin | ¥18,000 | 3 |

- No price increase
- No rooms became unavailable

See [the booking page](https://hotel.example.test/rooms) for details.`;

describe("a watcher's answer, rendered", () => {
  it("turns a first-level heading into a heading", () => {
    const markup = html(HOTEL_OUTPUT);

    expect(markup).toMatch(/<h[1-6][^>]*>Hotel availability change<\/h[1-6]>/);
  });

  it("turns a second-level heading into a heading too", () => {
    const markup = html(HOTEL_OUTPUT);

    expect(markup).toMatch(/<h[1-6][^>]*>Newly available rooms<\/h[1-6]>/);
  });

  /**
   * **Never another `<h1>`.** The page already has one; a model's `#` is a
   * section of an answer, not the title of the document.
   */
  it("does not introduce a second document title", () => {
    expect(html(HOTEL_OUTPUT)).not.toContain("<h1");
  });

  it("renders emphasis as emphasis rather than as asterisks", () => {
    const markup = html(HOTEL_OUTPUT);

    expect(markup).toMatch(/<strong[^>]*>Newly available<\/strong>/);
    expect(text(HOTEL_OUTPUT)).not.toContain("**Newly available**");
  });

  it("renders italics", () => {
    expect(html("Rooms are *limited*.")).toMatch(/<em[^>]*>limited<\/em>/);
  });

  it("renders an unordered list", () => {
    const markup = html(HOTEL_OUTPUT);

    expect(markup).toContain("<ul");
    expect(markup).toMatch(/<li[^>]*>No price increase<\/li>/);
  });

  it("renders an ordered list", () => {
    const markup = html("1. Check dates\n2. Book the room\n");

    expect(markup).toContain("<ol");
    expect(markup).toMatch(/<li[^>]*>Check dates<\/li>/);
  });

  it("renders inline code", () => {
    expect(html("The field is `checkin`.")).toMatch(
      /<code[^>]*>checkin<\/code>/,
    );
  });

  it("renders a fenced code block", () => {
    const markup = html("```\ncheckin=2026-10-01\n```\n");

    expect(markup).toContain("<pre");
    expect(markup).toContain("checkin=2026-10-01");
  });

  /** None of the source markers survive as literal characters. */
  it("leaves no raw Markdown markers in the reading", () => {
    const reading = text(HOTEL_OUTPUT);

    expect(reading).not.toContain("# Hotel");
    expect(reading).not.toContain("## Newly");
    expect(reading).not.toContain("| --- |");
    expect(reading).toContain("Hotel availability change");
  });

  /** A run that produced nothing renders nothing, rather than failing. */
  it("renders an empty answer without complaint", () => {
    expect(() => html("")).not.toThrow();
  });
});

describe("a table in a watcher's answer", () => {
  it("becomes a real table", () => {
    const markup = html(HOTEL_OUTPUT);

    expect(markup).toContain("<table");
    expect(markup).toContain("<thead");
    expect(markup).toMatch(/<th[^>]*>Plan<\/th>/);
    expect(markup).toMatch(/<td[^>]*>Double<\/td>/);
    expect(markup).toContain("¥15,000");
  });

  /**
   * **The wrapper is what makes it usable on a phone.** Four columns do not
   * fit, and letting the cells wrap turns numbers into stacks nobody can
   * compare — so the table scrolls sideways inside the page rather than
   * widening it.
   */
  it("is wrapped in something that scrolls sideways", () => {
    const markup = html(HOTEL_OUTPUT);
    const wrapper = markup.slice(0, markup.indexOf("<table"));

    expect(wrapper).toContain("overflow-x-auto");
  });

  it("keeps the table from being squeezed narrower than its content", () => {
    expect(html(HOTEL_OUTPUT)).toMatch(/<table[^>]*min-w-max/);
  });

  /** GFM column alignment survives, since the fixture right-aligns a price. */
  it("keeps the column alignment the answer asked for", () => {
    expect(html(HOTEL_OUTPUT)).toMatch(/text-align:\s*right/);
  });
});

/**
 * Links a model wrote.
 *
 * **Untrusted, like everything else in the output.** The addresses were not
 * chosen by the account, so the safe ones get the external-link treatment and
 * the dangerous ones never reach an anchor at all.
 */
describe("links a model wrote", () => {
  it("makes a safe https link followable", () => {
    const markup = html(HOTEL_OUTPUT);

    expect(markup).toContain('href="https://hotel.example.test/rooms"');
    expect(markup).toContain("the booking page");
  });

  it("makes a safe http link followable", () => {
    expect(html("[a page](http://example.test/x)")).toContain(
      'href="http://example.test/x"',
    );
  });

  /** It leaves Koqentra, so it opens on its own and tells the site nothing. */
  it("opens an external link in its own tab, with no referrer", () => {
    const markup = html(HOTEL_OUTPUT);

    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer nofollow"');
  });

  /**
   * **A relative link stays ordinary.** It can only lead back into Koqentra,
   * where a new tab would be unexplained.
   */
  it("leaves a relative link as an ordinary link", () => {
    const markup = html("[the run](/dashboard/runs/run-1)");

    expect(markup).toContain('href="/dashboard/runs/run-1"');
    expect(markup).not.toContain('target="_blank"');
  });

  /**
   * **The dangerous schemes never reach an anchor.** `defaultUrlTransform`
   * empties them, which was measured against the installed version rather than
   * assumed — these are what keep it measured.
   */
  it.each([
    ["javascript", "[click me](javascript:alert(1))"],
    ["data", "[click me](data:text/html;base64,PHNjcmlwdD4=)"],
    ["file", "[click me](file:///etc/passwd)"],
  ])("emits no %s address as a followable link", (scheme, markdown) => {
    const markup = html(markdown);

    expect(markup).not.toContain(`href="${scheme}:`);
    expect(markup).not.toContain(`${scheme}:`);
    // The words are still shown; only the destination is gone.
    expect(text(markdown)).toContain("click me");
  });

  it("emits no executable address in a reference-style link either", () => {
    const markup = html("[click me][x]\n\n[x]: javascript:alert(1)\n");

    expect(markup).not.toContain("javascript:");
  });
});

/**
 * HTML a model wrote.
 *
 * **Nothing here executes, and the reason is structural.** `react-markdown`
 * builds React elements and never hands a string to the DOM, so an HTML node in
 * the tree is simply not rendered. The plugin that would change that,
 * `rehype-raw`, is not installed — and a test below says so, because installing
 * it is the one edit that would quietly undo all of this.
 */
describe("HTML a model wrote", () => {
  /**
   * **What actually happens, measured rather than assumed.** Raw HTML comes
   * back as escaped text — `&lt;img src=x onerror=&quot;…&quot;&gt;` — so a
   * browser shows the characters and builds no element at all. There is no tag
   * for an attribute to sit on, which is why the assertions below are about the
   * unescaped forms: those are the ones that would mean something ran.
   */
  it("shows a script tag as characters rather than building one", () => {
    const markup = html("Before\n\n<script>alert(1)</script>\n\nAfter");

    expect(markup).not.toContain("<script");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("Before");
    expect(markup).toContain("After");
  });

  it("builds no image, so no handler has an attribute to occupy", () => {
    const markup = html('<img src=x onerror="alert(1)">');

    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
    expect(markup).not.toMatch(/<[a-z]+[^>]*\sonerror=/i);
  });

  it.each([
    [
      "an iframe",
      '<iframe src="https://evil.example.test"></iframe>',
      "<iframe",
    ],
    ["an inline handler on a link", '<a href="#" onclick="alert(1)">x</a>', "<a href=\"#\""],
    ["a form", '<form action="https://evil.example.test"><input></form>', "<form"],
    ["a style block", "<style>body{display:none}</style>", "<style"],
  ])("builds no %s", (_label, markdown, forbidden) => {
    const markup = html(markdown);

    expect(markup).not.toContain(forbidden);
    // The general rule the four cases share: no element in the output carries
    // an inline event handler.
    expect(markup).not.toMatch(/<[a-z]+[^>]*\son[a-z]+=/i);
  });

  /** Inline HTML inside a paragraph is escaped the same way. */
  it("escapes inline HTML without dropping the sentence around it", () => {
    const markdown = 'Rooms <b onclick="alert(1)">are</b> available.';
    const markup = html(markdown);

    expect(text(markdown)).toContain("Rooms");
    expect(text(markdown)).toContain("available.");
    expect(markup).not.toContain("<b ");
    expect(markup).not.toMatch(/<[a-z]+[^>]*\son[a-z]+=/i);
  });

  /**
   * **The single property all of the above are instances of.** Whatever HTML a
   * model writes, the rendered output contains no element this component did
   * not itself choose to emit.
   */
  it("emits no element carrying an inline event handler, whatever the input", () => {
    for (const markdown of [
      '<img src=x onerror="alert(1)">',
      '<div onmouseover="alert(1)">hover</div>',
      '<svg onload="alert(1)"></svg>',
      '<body onload="alert(1)">',
      "<script>alert(1)</script>",
    ]) {
      expect(html(markdown)).not.toMatch(/<[a-z]+[^>]*\son[a-z]+=/i);
    }
  });
});

/**
 * **The two guarantees that a future edit could silently remove**, fixed as
 * tests so that removing them fails the build rather than a reader.
 */
describe("what the renderer is not allowed to become", () => {
  /**
   * **The attribute form, not the word.** The component's own docblock names
   * both of these to explain why they are absent, so the assertion is about
   * them being used rather than mentioned.
   */
  it("never reaches for dangerouslySetInnerHTML", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("components/run-output-markdown.tsx", "utf8");

    expect(source).not.toMatch(/dangerouslySetInnerHTML\s*=/);
  });

  it("imports no raw-HTML plugin, and rehype-raw is not a dependency", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("components/run-output-markdown.tsx", "utf8");
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(source).not.toMatch(/from\s+"rehype-raw"/);
    expect(source).not.toMatch(/rehypePlugins/);
    expect(manifest.dependencies).not.toHaveProperty("rehype-raw");
    expect(manifest.devDependencies).not.toHaveProperty("rehype-raw");
  });

  /** One Markdown stack, and no HTML sanitiser standing in for one. */
  it("adds no second Markdown or sanitiser stack", async () => {
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };

    for (const unwanted of [
      "marked",
      "markdown-it",
      "sanitize-html",
      "dompurify",
      "isomorphic-dompurify",
    ]) {
      expect(manifest.dependencies).not.toHaveProperty(unwanted);
    }
  });
});
