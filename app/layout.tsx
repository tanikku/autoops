import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NotificationProvider } from "@/components/notification/notification-provider";
import { getDocumentLanguage } from "@/lib/i18n/server";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Koqentra — AI Content Editor",
  description:
    "Evaluate content for X, Reddit, and long-form, get drafts for what is worth using, and keep the final decision with you.",
};

/**
 * **The document says which language it is in, and it is asked every request.**
 *
 * It used to say English on every page, including a dashboard rendered entirely
 * in Japanese. A screen reader believes that attribute — it decides which voice
 * and pronunciation to use from it — and browsers read it when choosing a font
 * for text the stylesheet leaves open. Saying the wrong thing confidently is
 * worse than the markup that would have been produced by saying nothing.
 *
 * **Resolved above the pages rather than by them.** This element is written
 * once for the whole tree, so the answer has to be known here; the pages below
 * already read the same value for their own words, and `getUserLanguage` is
 * memoized per request so asking again costs no second query.
 *
 * **Reading only.** Anonymous requests — the landing page and the privacy
 * notice — get English without the database being asked at all, and nothing
 * here provisions an account row.
 */
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const language = await getDocumentLanguage();

  return (
    <html
      lang={language}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <NotificationProvider>{children}</NotificationProvider>
      </body>
    </html>
  );
}
