import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * What a model wrote, shown as it meant it to be read.
 *
 * **The output is untrusted text, and that decides the whole design.** It comes
 * from a model, which was shown a page somebody else controls; a heading and a
 * table are worth rendering, and nothing in it is worth executing.
 *
 * **Raw HTML cannot run, and that is structural rather than configured.**
 * `react-markdown` builds React elements and never hands a string to the DOM —
 * there is no `dangerouslySetInnerHTML` here or under it. An `<img onerror>` or
 * a `<script>` in the output arrives as an HTML node in the tree that nothing
 * renders, so it appears as nothing at all. The plugin that would change that,
 * `rehype-raw`, is deliberately not installed: turning it on is the one edit
 * that would make every sentence above untrue.
 *
 * **Unsafe link schemes are dropped before they reach an anchor.** The library's
 * own `defaultUrlTransform` empties `javascript:`, `data:` and `file:`, which
 * was measured rather than assumed — see this component's tests. It is left in
 * place rather than replaced: a second policy written here would be a second
 * thing to keep in step with a list somebody else maintains carefully.
 *
 * **Styled locally, and only here.** No typography plugin and no global
 * stylesheet: what this does to a heading applies to run output and to nothing
 * else on any other screen.
 */

/** Whether a link leaves Koqentra, and so needs the external-link treatment. */
function isExternal(href: string | undefined): boolean {
  return href !== undefined && /^https?:\/\//i.test(href);
}

export function RunOutputMarkdown({ children }: { children: string }) {
  return (
    // `break-words` for the long unbroken strings a model sometimes produces;
    // `leading-relaxed` because several screens of output at the default line
    // height is hard to follow on a phone.
    <div className="text-sm leading-relaxed break-words">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Headings step down in size without ever becoming another `h1`: the
          // page already has one, and a model's `#` is a section of an answer
          // rather than the title of the document.
          h1: ({ children: content }) => (
            <h3 className="mt-6 text-base font-semibold tracking-tight first:mt-0">
              {content}
            </h3>
          ),
          h2: ({ children: content }) => (
            <h4 className="mt-5 text-sm font-semibold tracking-tight first:mt-0">
              {content}
            </h4>
          ),
          h3: ({ children: content }) => (
            <h5 className="mt-4 text-sm font-medium tracking-tight first:mt-0">
              {content}
            </h5>
          ),
          p: ({ children: content }) => (
            <p className="mt-3 first:mt-0">{content}</p>
          ),
          strong: ({ children: content }) => (
            <strong className="font-semibold">{content}</strong>
          ),
          em: ({ children: content }) => <em className="italic">{content}</em>,
          ul: ({ children: content }) => (
            <ul className="mt-3 list-disc space-y-1 pl-5 first:mt-0">
              {content}
            </ul>
          ),
          ol: ({ children: content }) => (
            <ol className="mt-3 list-decimal space-y-1 pl-5 first:mt-0">
              {content}
            </ol>
          ),
          li: ({ children: content }) => <li>{content}</li>,
          // Inline code and a fenced block are the same element in Markdown's
          // tree, told apart by whether a `<pre>` wraps them. The block gets
          // its own scroll so a long line does not widen the page.
          code: ({ children: content, className }) => (
            <code
              className={`rounded bg-muted-foreground/15 px-1 py-0.5 font-mono text-[0.85em] ${className ?? ""}`}
            >
              {content}
            </code>
          ),
          pre: ({ children: content }) => (
            <pre className="mt-3 overflow-x-auto rounded-lg bg-background/60 p-3 text-xs first:mt-0">
              {content}
            </pre>
          ),
          /**
           * **The wrapper is the mobile fix.** A table of four columns does not
           * fit a phone, and letting the cells wrap turns numbers into stacks
           * nobody can compare. Scrolling the table sideways keeps the rows
           * readable and leaves the page itself the width of the screen.
           */
          table: ({ children: content }) => (
            <div className="mt-3 -mx-1 overflow-x-auto first:mt-0">
              <table className="w-full min-w-max border-collapse text-left text-xs">
                {content}
              </table>
            </div>
          ),
          thead: ({ children: content }) => (
            <thead className="border-b border-border">{content}</thead>
          ),
          th: ({ children: content, style }) => (
            <th className="px-2 py-1.5 font-medium whitespace-nowrap" style={style}>
              {content}
            </th>
          ),
          td: ({ children: content, style }) => (
            <td
              className="border-t border-border/60 px-2 py-1.5 align-top"
              style={style}
            >
              {content}
            </td>
          ),
          blockquote: ({ children: content }) => (
            <blockquote className="mt-3 border-l-2 border-border pl-3 text-muted-foreground first:mt-0">
              {content}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-border" />,
          /**
           * **A model's link is still a model's link.** It was not chosen by
           * the account and may point anywhere, so an address that leaves
           * Koqentra opens in its own tab, tells the destination nothing about
           * where it came from, and passes on no ranking.
           *
           * **A relative link gets none of that.** The library allows them and
           * they can only lead back into Koqentra, where `target="_blank"`
           * would be an unexplained new tab.
           */
          a: ({ children: content, href }) =>
            isExternal(href) ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="underline underline-offset-2"
              >
                {content}
              </a>
            ) : (
              <a href={href} className="underline underline-offset-2">
                {content}
              </a>
            ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
