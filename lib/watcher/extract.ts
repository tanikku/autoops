import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { WatcherError } from "@/lib/watcher/errors";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type TextNode = DefaultTreeAdapterTypes.TextNode;

/**
 * Elements whose contents are not the document.
 *
 * Each is dropped along with everything inside it. They are not hidden text —
 * they are not text: a script is a program, a style sheet is presentation, an
 * `svg` or `canvas` is a picture, an `iframe` is somebody else's page, and a
 * `template` is markup waiting to be used rather than markup being shown.
 * `noscript` is the alternative for a reader who will never see this one.
 *
 * **Leaving any of them in would make change detection useless rather than
 * noisy.** Inline scripts carry nonces, request ids and timestamps that differ
 * on every response, so a watcher would report a change every time it looked.
 */
const NON_CONTENT_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
]);

/**
 * Elements that start a new line of text, so that the words either side of them
 * are separate words.
 *
 * **Named explicitly, and everything else flows inline.** The tempting
 * arrangement is the reverse — list what is inline and treat the unknown as a
 * boundary — on the grounds that an extra space is harmless while running two
 * sentences together is not. That reasoning is wrong here, and the case it gets
 * wrong is the one this whole layer exists to avoid:
 *
 * ```html
 * <span>A</span><span>B</span>          →  AB
 * <custom-a>A</custom-a><custom-b>B</custom-b>
 * ```
 *
 * If an unknown element is a boundary, the second reads `A B`, the digest moves,
 * and a watcher reports a change to a reader who can see that nothing on the
 * page is different. **A markup-only edit becoming a reported change is a false
 * positive**, and enough of them make the feature not worth watching.
 *
 * The default is also the one the platform itself uses: an element nobody has
 * styled is `display: inline`, so treating a custom element as a block is not a
 * conservative choice but a guess about CSS — and this layer reads no CSS.
 *
 * The names below are the elements whose default rendering is block-level, a
 * list, or part of a table. Nothing here is inferred at run time.
 */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "html",
  "legend",
  "li",
  "listing",
  "main",
  "menu",
  "nav",
  "ol",
  "optgroup",
  "option",
  "p",
  "plaintext",
  "pre",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "xmp",
]);

/**
 * What separates one block from the next.
 *
 * A newline rather than a space because it survives being read in a debugger,
 * and because whitespace normalisation collapses it to a single space anyway —
 * every run of whitespace ends up identical, so what is pushed here only has to
 * *be* whitespace.
 */
const BOUNDARY = "\n";

/**
 * The readable text of a document, in the order it is written.
 *
 * **This is not the text a browser would show, and it does not try to be.**
 * Rendered visibility depends on style sheets, class names, computed layout and
 * a rendering engine, none of which is available here and none of which can be
 * half-implemented without leaving "visible" meaning something different in
 * every case. What this produces instead is the document with the parts that
 * are explicitly not content removed — a definition that can be stated in one
 * sentence and tested.
 *
 * Two consequences worth stating plainly:
 *
 * - **`aria-hidden` is not honoured.** It describes what assistive technology
 *   should announce, which is frequently not the same as what is on screen —
 *   decorative duplicates are marked with it, and so are things that are very
 *   much visible.
 * - **Inline `style` is not honoured either.** Reading `display:none` from an
 *   attribute while ignoring the style sheet that sets the same thing on a
 *   class would be arbitrary: the same page would be treated differently
 *   depending on where its authors happened to put the rule.
 *
 * `hidden` is the exception, and it is an exception because it is not styling:
 * it is an HTML attribute whose meaning is "this element is not currently
 * relevant", stated in the markup itself.
 *
 * **Attributes are otherwise invisible to this.** Nothing reads `class`, `id`,
 * `data-*` or `href`, so the churn a build produces — hashed class names,
 * request ids, cache-busting parameters — cannot reach the text.
 *
 * **Tag names are almost invisible too.** Only the two lists below consult
 * them: one says what is not content at all, the other says what starts a new
 * line. Everything else — including every element this has never heard of —
 * flows inline, so rewriting a component's markup without changing a word
 * leaves the text exactly as it was.
 *
 * From `head`, only `title` is taken. A title is shown to the reader and worth
 * watching; descriptions, canonical links and Open Graph tags are written for
 * other machines and change on their own schedule.
 */
export function extractDocumentText(html: string): string {
  let document: DefaultTreeAdapterTypes.Document;

  try {
    document = parse(html);
  } catch (error) {
    // **Recovering from bad markup is the parser's job and it is good at it**,
    // so this is not "the HTML was invalid" — that is the ordinary case and it
    // succeeds. This is the parser itself failing, which leaves nothing to
    // compare against.
    throw new WatcherError(
      "normalization-failed",
      "The page could not be read as a document.",
      { cause: error },
    );
  }

  const parts: string[] = [];
  appendChildren(document, parts);
  return parts.join("");
}

function appendChildren(node: Node, parts: string[]): void {
  if (!("childNodes" in node)) {
    return;
  }

  for (const child of node.childNodes) {
    appendNode(child, parts);
  }
}

function appendNode(node: Node, parts: string[]): void {
  if (isTextNode(node)) {
    parts.push(node.value);
    return;
  }

  if (!isElement(node)) {
    // Comments and the doctype. Neither is shown to anyone.
    return;
  }

  const tag = node.tagName;

  if (NON_CONTENT_TAGS.has(tag) || isHidden(node)) {
    return;
  }

  if (tag === "head") {
    appendHeadTitle(node, parts);
    return;
  }

  if (tag === "br") {
    // A line break is a boundary with nothing on either side of it — the one
    // element whose whole contribution is the separation it causes.
    parts.push(BOUNDARY);
    return;
  }

  if (!BLOCK_TAGS.has(tag)) {
    // Inline, including every element this has never heard of. Renaming a
    // `<span>` to `<my-widget>` must not move a single character of the text.
    appendChildren(node, parts);
    return;
  }

  parts.push(BOUNDARY);
  appendChildren(node, parts);
  parts.push(BOUNDARY);
}

/** From the head, the title and nothing else. */
function appendHeadTitle(head: Element, parts: string[]): void {
  for (const child of head.childNodes) {
    if (isElement(child) && child.tagName === "title") {
      parts.push(BOUNDARY);
      appendChildren(child, parts);
      parts.push(BOUNDARY);
    }
  }
}

/**
 * Whether the markup says this element is not currently relevant.
 *
 * Presence is the test, as it is for every boolean attribute in HTML:
 * `hidden`, `hidden=""` and `hidden="false"` all mean hidden.
 */
function isHidden(element: Element): boolean {
  return element.attrs.some((attribute) => attribute.name === "hidden");
}

function isTextNode(node: Node): node is TextNode {
  return node.nodeName === "#text";
}

function isElement(node: Node): node is Element {
  return "tagName" in node;
}
