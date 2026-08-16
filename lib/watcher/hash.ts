import { createHash } from "node:crypto";

/**
 * The digest a snapshot is compared by.
 *
 * **SHA-256 over the UTF-8 bytes of the normalized text, and nothing else.**
 * Not the URL, not the worker, not the source, not the time it was read, not a
 * header, not an attribute — mixing any of those in would make two identical
 * pages hash differently and report a change that did not happen. The same text
 * always produces the same digest, whoever asked for it and whenever.
 *
 * Lower-case hexadecimal, because a digest that is compared as a string has to
 * have one spelling.
 *
 * It is a comparison shortcut rather than a security property: the content it
 * covers is stored alongside it, and the comparison falls back to the text
 * whenever the two disagree.
 */
export function contentHashOf(normalizedContent: string): string {
  return createHash("sha256").update(normalizedContent, "utf8").digest("hex");
}
