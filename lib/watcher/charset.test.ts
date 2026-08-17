import { describe, expect, it } from "vitest";
import { resolveSupportedCharset } from "@/lib/watcher/charset";

/**
 * Which spellings of an encoding are understood, and which are refused.
 *
 * **The table is wider than the platform's own**, deliberately: `cp932`,
 * `windows-932` and `euc_jp` are all served by real sites and all rejected by
 * `TextDecoder`, so without the mapping those pages could not be read at all.
 * What it must never do is accept a label it cannot honour — every canonical
 * name below is one the decoder takes, and the tests in `decode.test.ts` are
 * what prove that end to end.
 */

describe("UTF-8", () => {
  it.each(["utf-8", "UTF-8", "utf8", "UTF8", "unicode-1-1-utf-8", " utf-8 "])(
    "reads %o as utf-8",
    (label) => {
      expect(resolveSupportedCharset(label)).toBe("utf-8");
    },
  );
});

/**
 * **Canonically `shift_jis`, which is what the platform calls it.** The name is
 * the decoder's rather than the specification table's on purpose: a canonical
 * name the decoder does not accept would need a second mapping to be useful.
 * What it decodes is Windows-31J — see the extended-character test in
 * `decode.test.ts`.
 */
describe("Shift_JIS and its many names", () => {
  it.each([
    "shift_jis",
    "Shift_JIS",
    "SHIFT_JIS",
    "shift-jis",
    "sjis",
    "x-sjis",
    "ms_kanji",
    "csshiftjis",
    "windows-31j",
    "Windows-31J",
    "cp932",
    "CP932",
    "ms932",
    "windows-932",
  ])("reads %o as shift_jis", (label) => {
    expect(resolveSupportedCharset(label)).toBe("shift_jis");
  });
});

describe("EUC-JP", () => {
  it.each(["euc-jp", "EUC-JP", "euc_jp", "eucjp", "x-euc-jp", "cseucpkdfmtjapanese"])(
    "reads %o as euc-jp",
    (label) => {
      expect(resolveSupportedCharset(label)).toBe("euc-jp");
    },
  );
});

describe("UTF-16", () => {
  it.each(["utf-16le", "UTF-16LE", "utf-16", "UTF-16"])(
    "reads %o as utf-16le",
    (label) => {
      expect(resolveSupportedCharset(label)).toBe("utf-16le");
    },
  );

  it.each(["utf-16be", "UTF-16BE"])("reads %o as utf-16be", (label) => {
    expect(resolveSupportedCharset(label)).toBe("utf-16be");
  });
});

describe("quoting and padding a header brings with it", () => {
  it.each(['"UTF-8"', "'utf-8'", '  "utf-8"  ', ' Windows-31J '])(
    "sees through %o",
    (label) => {
      expect(resolveSupportedCharset(label)).not.toBeNull();
    },
  );
});

/**
 * **Null is a refusal, not a fallback.** Reading a page that says `big5` as
 * UTF-8 would produce text that is wrong in a way nothing downstream could
 * detect, and it would be stored as the baseline everything is compared to.
 */
describe("encodings this does not read", () => {
  it.each([
    "iso-2022-jp",
    "big5",
    "gb18030",
    "gbk",
    "koi8-r",
    "iso-8859-1",
    "windows-1252",
    "utf-32",
    "utf-7",
  ])("refuses %o", (label) => {
    expect(resolveSupportedCharset(label)).toBeNull();
  });

  it.each(["", "   ", "not-an-encoding", "utf", "shift", "utf-8-ish"])(
    "refuses the malformed label %o",
    (label) => {
      expect(resolveSupportedCharset(label)).toBeNull();
    },
  );

  it.each([null, undefined])("refuses %o", (label) => {
    expect(resolveSupportedCharset(label)).toBeNull();
  });
});
