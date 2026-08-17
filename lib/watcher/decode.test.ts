import { describe, expect, it } from "vitest";
import {
  decodeWebsiteContent,
  META_CHARSET_SCAN_BYTES,
} from "@/lib/watcher/decode";
import { isWatcherError, type WatcherError } from "@/lib/watcher/errors";

/**
 * Turning bytes into text, and refusing to guess while doing it.
 *
 * **The failures are the subject as much as the successes.** A decoder that
 * quietly produces something for every input is worse than one that refuses,
 * because what it produces gets hashed, stored as the baseline, and compared
 * against for as long as the worker exists. Every case below that ends in an
 * error is a case where the alternative was a page that looked fine and was
 * wrong.
 */

const HTML = "text/html";

/** The kind a decode failed with, or the text it produced. */
function decode(bytes: Uint8Array, contentType: string | undefined): string {
  return decodeWebsiteContent(bytes, contentType).content;
}

function kindOf(bytes: Uint8Array, contentType: string | undefined): string {
  try {
    decodeWebsiteContent(bytes, contentType);
  } catch (error) {
    return isWatcherError(error)
      ? (error as WatcherError).kind
      : "not-a-watcher-error";
  }

  return "decoded";
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function utf8(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text, "utf-8"));
}

/** 日本語 in each encoding, as the bytes a server would actually send. */
const JAPANESE = "日本語";
const SHIFT_JIS = bytes(0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea);
const EUC_JP = bytes(0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec);
const UTF16LE = bytes(0xe5, 0x65, 0x2c, 0x67, 0x9e, 0x8a);
const UTF16BE = bytes(0x65, 0xe5, 0x67, 0x2c, 0x8a, 0x9e);

describe("which responses are decoded at all", () => {
  it.each([
    "text/html",
    "text/html; charset=utf-8",
    "text/html;charset=UTF-8",
    "TEXT/HTML; Charset=\"utf-8\"",
    "application/xhtml+xml",
    "application/xhtml+xml; charset=UTF-8",
    "text/html; charset=utf-8; boundary=x",
  ])("decodes %o", (contentType) => {
    expect(kindOf(utf8("<p>hi</p>"), contentType)).toBe("decoded");
  });

  /**
   * **Plain text is fetchable and not watchable.** The fetch accepts it because
   * it is text; this refuses it because Website Watcher reads documents, and
   * running plain text through an HTML parser invents structure the server
   * never sent.
   */
  it.each(["text/plain", "text/plain; charset=utf-8"])(
    "refuses %o, which the fetch is happy to read",
    (contentType) => {
      expect(kindOf(utf8("hello"), contentType)).toBe(
        "unsupported-content-type",
      );
    },
  );

  it.each([
    "application/json",
    "application/pdf",
    "image/png",
    "application/xml",
  ])("refuses %o", (contentType) => {
    expect(kindOf(utf8("x"), contentType)).toBe("unsupported-content-type");
  });

  it("refuses a response that said nothing about its type", () => {
    expect(kindOf(utf8("<p>hi</p>"), undefined)).toBe(
      "unsupported-content-type",
    );
  });

  it("refuses a header it cannot make a media type out of", () => {
    expect(kindOf(utf8("<p>hi</p>"), ";;;")).toBe("unsupported-content-type");
  });

  it("reports which media type it decoded", () => {
    expect(
      decodeWebsiteContent(utf8("<p>hi</p>"), "application/xhtml+xml").mediaType,
    ).toBe("application/xhtml+xml");
  });
});

describe("UTF-8", () => {
  it("is the default when nothing says otherwise", () => {
    const result = decodeWebsiteContent(utf8("<p>hi</p>"), HTML);

    expect(result.content).toBe("<p>hi</p>");
    expect(result.charset).toBe("utf-8");
  });

  it.each(["utf-8", "UTF-8", "utf8", '"utf-8"'])(
    "honours a header saying %o",
    (label) => {
      expect(decode(utf8(JAPANESE), `text/html; charset=${label}`)).toBe(
        JAPANESE,
      );
    },
  );

  it("reads Japanese", () => {
    expect(decode(utf8(JAPANESE), HTML)).toBe(JAPANESE);
  });

  it("reads emoji", () => {
    expect(decode(utf8("在庫あり ✅"), HTML)).toBe("在庫あり ✅");
  });
});

describe("Shift_JIS, which is Windows-31J in practice", () => {
  it.each([
    "shift_jis",
    "Shift_JIS",
    "windows-31j",
    "cp932",
    "ms932",
    "windows-932",
    '"Windows-31J"',
  ])("reads Japanese declared as %o", (label) => {
    expect(decode(SHIFT_JIS, `text/html; charset=${label}`)).toBe(JAPANESE);
  });

  /**
   * `①` at `0x87 0x40` exists in Windows-31J and not in the original
   * Shift_JIS. It decoding correctly is what makes the CP932 aliases above
   * honest rather than approximate.
   */
  it("reads a character only Windows-31J has", () => {
    expect(decode(bytes(0x87, 0x40), "text/html; charset=windows-31j")).toBe(
      "①",
    );
  });

  it("reports the encoding it used", () => {
    expect(
      decodeWebsiteContent(SHIFT_JIS, "text/html; charset=cp932").charset,
    ).toBe("shift_jis");
  });
});

describe("EUC-JP", () => {
  it.each(["euc-jp", "EUC-JP", "euc_jp", "x-euc-jp"])(
    "reads Japanese declared as %o",
    (label) => {
      expect(decode(EUC_JP, `text/html; charset=${label}`)).toBe(JAPANESE);
    },
  );
});

describe("UTF-16", () => {
  it("reads little-endian from a header", () => {
    expect(decode(UTF16LE, "text/html; charset=utf-16le")).toBe(JAPANESE);
  });

  it("reads big-endian from a header", () => {
    expect(decode(UTF16BE, "text/html; charset=utf-16be")).toBe(JAPANESE);
  });

  it("reads little-endian from a byte order mark alone", () => {
    expect(decode(bytes(0xff, 0xfe, ...UTF16LE), HTML)).toBe(JAPANESE);
  });

  it("reads big-endian from a byte order mark alone", () => {
    expect(decode(bytes(0xfe, 0xff, ...UTF16BE), HTML)).toBe(JAPANESE);
  });
});

/**
 * **A mark left in the text would reach the hash.** The same page served with
 * and without one would then compare as two different pages, and a watcher
 * would report a change that is a byte of metadata.
 */
describe("byte order marks do not survive into the text", () => {
  it.each([
    ["UTF-8", bytes(0xef, 0xbb, 0xbf, ...utf8("<p>hi</p>")), "<p>hi</p>"],
    ["UTF-16LE", bytes(0xff, 0xfe, 0x41, 0x00), "A"],
    ["UTF-16BE", bytes(0xfe, 0xff, 0x00, 0x41), "A"],
  ])("strips the %s mark", (_name, input, expected) => {
    const content = decode(input, HTML);

    expect(content).toBe(expected);
    expect(content.startsWith("﻿")).toBe(false);
  });

  it("produces the same text with and without a UTF-8 mark", () => {
    expect(decode(bytes(0xef, 0xbb, 0xbf, ...utf8("<p>hi</p>")), HTML)).toBe(
      decode(utf8("<p>hi</p>"), HTML),
    );
  });
});

describe("a charset declared in the markup", () => {
  it("is used when neither a mark nor a header says anything", () => {
    const page = bytes(
      ...utf8('<html><head><meta charset="Shift_JIS"></head><body>'),
      ...SHIFT_JIS,
      ...utf8("</body></html>"),
    );

    expect(decode(page, HTML)).toContain(JAPANESE);
  });

  it("is read from the legacy http-equiv form too", () => {
    const page = bytes(
      ...utf8(
        '<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">',
      ),
      ...SHIFT_JIS,
    );

    expect(decode(page, HTML)).toContain(JAPANESE);
  });

  it.each([
    ['<meta charset="shift_jis">', "lower case"],
    ["<META CHARSET='Shift_JIS'>", "upper case and single quotes"],
    ["<meta charset=Shift_JIS>", "no quotes"],
    ["<meta  charset = 'Shift_JIS' >", "extra spacing"],
    [
      '<meta content="text/html; charset=Shift_JIS" http-equiv="Content-Type">',
      "attributes the other way round",
    ],
    ['<meta name="x" content="y"><meta charset="Shift_JIS">', "a second meta"],
  ])("reads %o — %s", (declaration) => {
    expect(decode(bytes(...utf8(declaration), ...SHIFT_JIS), HTML)).toContain(
      JAPANESE,
    );
  });

  /**
   * **The prefix is searched as bytes, never decoded first.** Decoding the
   * whole body to find out how to decode the body is the bug this module
   * exists to remove: it would fail on exactly the pages whose declaration
   * matters.
   */
  it("finds a declaration in a page that is not valid UTF-8", () => {
    const page = bytes(...utf8('<meta charset="euc-jp">'), ...EUC_JP);

    expect(decode(page, HTML)).toContain(JAPANESE);
  });
});

describe("how far into the page a declaration is looked for", () => {
  function pageWithDeclarationAfter(padding: number): Uint8Array {
    return bytes(
      ...utf8(`<!--${"x".repeat(padding)}-->`),
      ...utf8('<meta charset="Shift_JIS">'),
      ...SHIFT_JIS,
    );
  }

  it("finds one inside the scanned prefix", () => {
    expect(decode(pageWithDeclarationAfter(1_000), HTML)).toContain(JAPANESE);
  });

  /**
   * Past the limit the declaration is not seen, so the default applies — and
   * these bytes are not valid UTF-8, so the page is refused rather than
   * mangled. **Ignoring it silently and storing nonsense is the outcome this
   * avoids.**
   */
  it("does not find one past the limit", () => {
    expect(kindOf(pageWithDeclarationAfter(META_CHARSET_SCAN_BYTES), HTML)).toBe(
      "invalid-encoding",
    );
  });

  it("scans a fixed number of bytes, so what was looked at is never in doubt", () => {
    expect(META_CHARSET_SCAN_BYTES).toBe(8 * 1024);
  });
});

/**
 * The order is the whole contract: the bytes' own claim, then the server's,
 * then the document's, then the default.
 */
describe("which claim wins", () => {
  it("prefers a byte order mark to the header", () => {
    const page = bytes(0xef, 0xbb, 0xbf, ...utf8(JAPANESE));

    expect(decode(page, "text/html; charset=utf-8")).toBe(JAPANESE);
  });

  it("prefers the header to a declaration in the markup", () => {
    const page = bytes(
      ...utf8('<meta charset="shift_jis">'),
      ...utf8(JAPANESE),
    );

    expect(decode(page, "text/html; charset=utf-8")).toContain(JAPANESE);
  });

  it("prefers a declaration in the markup to the default", () => {
    const page = bytes(...utf8('<meta charset="euc-jp">'), ...EUC_JP);

    expect(decodeWebsiteContent(page, HTML).charset).toBe("euc-jp");
  });

  it("falls back to UTF-8 when nothing said anything", () => {
    expect(decodeWebsiteContent(utf8("<p>hi</p>"), HTML).charset).toBe("utf-8");
  });
});

/**
 * **A mark and a header that disagree is a broken response**, and there is no
 * reading of it where one of them is obviously right. Choosing silently is how
 * the wrong choice gets stored.
 */
describe("a response that contradicts itself", () => {
  it.each([
    ["a UTF-16LE mark against a Shift_JIS header", bytes(0xff, 0xfe, 0x41, 0x00), "shift_jis"],
    ["a UTF-8 mark against a UTF-16LE header", bytes(0xef, 0xbb, 0xbf, 0x41), "utf-16le"],
    ["a UTF-16BE mark against a UTF-8 header", bytes(0xfe, 0xff, 0x00, 0x41), "utf-8"],
  ])("refuses %s", (_name, input, charset) => {
    expect(kindOf(input, `text/html; charset=${charset}`)).toBe(
      "encoding-conflict",
    );
  });

  it("accepts a mark and a header that agree", () => {
    expect(
      kindOf(bytes(0xef, 0xbb, 0xbf, 0x41), "text/html; charset=utf-8"),
    ).toBe("decoded");
  });
});

describe("encodings and bytes this refuses", () => {
  it.each(["big5", "iso-2022-jp", "gb18030", "koi8-r", "iso-8859-1"])(
    "refuses a header naming %o rather than reading it as something else",
    (label) => {
      expect(kindOf(utf8("<p>hi</p>"), `text/html; charset=${label}`)).toBe(
        "unsupported-charset",
      );
    },
  );

  it("refuses a malformed charset label", () => {
    expect(kindOf(utf8("<p>hi</p>"), "text/html; charset=not-an-encoding")).toBe(
      "unsupported-charset",
    );
  });

  it("refuses a declaration in the markup naming an unsupported encoding", () => {
    const page = bytes(...utf8('<meta charset="big5">'), ...utf8("<p>hi</p>"));

    expect(kindOf(page, HTML)).toBe("unsupported-charset");
  });

  it.each([
    ["invalid UTF-8", bytes(0xc3, 0x28), "utf-8"],
    ["invalid Shift_JIS", bytes(0x81, 0x20), "shift_jis"],
    ["invalid EUC-JP", bytes(0xa1, 0x20), "euc-jp"],
    ["a truncated UTF-16 unit", bytes(0x41), "utf-16le"],
  ])("refuses %s", (_name, input, charset) => {
    expect(kindOf(input, `text/html; charset=${charset}`)).toBe(
      "invalid-encoding",
    );
  });

  /**
   * **No rescue by guessing.** Shift_JIS bytes with nothing declaring them are
   * a page this cannot read, and reading them as some other encoding because
   * UTF-8 failed is exactly the heuristic that produces silent corruption.
   */
  it("refuses undeclared bytes that are not valid UTF-8", () => {
    expect(kindOf(SHIFT_JIS, HTML)).toBe("invalid-encoding");
  });

  /**
   * The one behaviour that would undo all of the above: a decoder that swaps
   * bad bytes for `` and reports success. The page would hash, store, and
   * compare as though it were fine.
   */
  it.each([
    ["invalid UTF-8", bytes(0xc3, 0x28), "text/html; charset=utf-8"],
    ["invalid Shift_JIS", bytes(0x81, 0x20), "text/html; charset=shift_jis"],
    ["undeclared Shift_JIS", SHIFT_JIS, HTML],
  ])("fails on %s rather than decoding it into replacement characters", (
    _name,
    input,
    contentType,
  ) => {
    // The assertion is the failure itself. A lenient decoder would return a
    // string here — one containing `` where the bytes could not be read —
    // and that string would hash, store as the baseline, and be compared
    // against for as long as the worker existed.
    expect(() => decodeWebsiteContent(input, contentType)).toThrow();
    expect(kindOf(input, contentType)).toBe("invalid-encoding");
  });
});

describe("an empty body", () => {
  it("decodes to an empty string rather than failing", () => {
    expect(decode(new Uint8Array(), HTML)).toBe("");
  });
});
