import Link from "next/link";
import { isSupportedLanguage, type Language } from "@/lib/i18n";

/**
 * Which language a public legal page is read in, and the control to change it.
 *
 * **A query parameter, only on these pages.** A visitor without a session has
 * no stored language, so the account's choice cannot help them reach the
 * Japanese text — which is the authoritative one for the legal notice and the
 * terms. `?lang=ja` / `?lang=en` overrides whatever else would decide; nothing
 * outside these three pages reads it, and nothing is stored.
 */

export type LegalSearchParams = Promise<{ lang?: string | string[] }>;

/** The language a `?lang=` asks for, or null when it asks for none we have. */
export async function requestedLegalLanguage(
  searchParams: LegalSearchParams | undefined,
): Promise<Language | null> {
  const value = (await searchParams)?.lang;
  const lang = Array.isArray(value) ? value[0] : value;

  return lang !== undefined && isSupportedLanguage(lang) ? lang : null;
}

export function LegalLanguageSwitch({
  path,
  language,
}: {
  path: string;
  language: Language;
}) {
  const options: { lang: Language; label: string }[] = [
    { lang: "ja", label: "日本語" },
    { lang: "en", label: "English" },
  ];

  return (
    <nav aria-label="Language" className="mt-4 flex gap-3 text-sm">
      {options.map((option) =>
        option.lang === language ? (
          <span key={option.lang} aria-current="true" className="font-medium">
            {option.label}
          </span>
        ) : (
          <Link
            key={option.lang}
            href={`${path}?lang=${option.lang}`}
            hrefLang={option.lang}
            className="text-muted-foreground underline underline-offset-4"
          >
            {option.label}
          </Link>
        ),
      )}
    </nav>
  );
}
