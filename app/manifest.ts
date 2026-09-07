import type { MetadataRoute } from "next";

/**
 * What a browser needs to install Koqentra as an app.
 *
 * **Packaging, not behaviour.** Everything here describes how Koqentra is
 * launched and what it is called once installed; nothing about how it works
 * changes. There is deliberately no service worker, no cache and no offline
 * story — an installed Koqentra is the same online product in a window without
 * browser chrome, and describing it as anything more would be a promise the
 * code does not keep. Installability is what Chromium asks for: a manifest, an
 * icon at 192 and 512, and HTTPS.
 *
 * **A route rather than a static file.** Next.js turns this default export into
 * `/manifest.webmanifest` and adds the `<link rel="manifest">` to every page
 * itself, so the document and the manifest cannot drift apart the way a
 * hand-maintained `public/manifest.json` and a hand-written `<link>` can.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    /**
     * **`id` before anything else, and never changing.** It is what a browser
     * uses to decide whether an installed app is *this* app. Left out, the
     * identity falls back to `start_url` — and then the day `start_url` moves,
     * every installed copy becomes a different app that has to be reinstalled.
     * `"/"` says Koqentra rather than any particular screen of it.
     */
    id: "/",
    name: "Koqentra",
    /** The same word: there is no shorter honest name to fall back to. */
    short_name: "Koqentra",
    /**
     * Word for word what the root metadata says.
     *
     * This is read in an install dialog by somebody deciding whether to keep
     * Koqentra on their device, which is exactly the moment for the sentence
     * the product already leads with — not a second description that drifts.
     */
    description:
      "Evaluate content for X, Reddit, and long-form, get drafts for what is worth using, and keep the final decision with you.",
    /**
     * **Creator, because that is what the product opens on.**
     *
     * Signed in, this lands directly on the screen somebody installed Koqentra
     * to use. Signed out it is not a special case: `/creator` is already behind
     * the middleware, so it redirects to `/`, and the sign-in there returns to
     * `/creator` anyway. The alternative — starting at `/` — would put the
     * marketing page in front of a signed-in person every single launch,
     * because that page deliberately does not read the session.
     */
    start_url: "/creator",
    /**
     * **The whole site, or the installed window is a trap.** Settings, Workers
     * and the privacy notice all live outside `/creator`; a narrower scope
     * would throw somebody out to a browser tab the first time they opened any
     * of them.
     */
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    /**
     * **Two purposes, because Android crops.** A launcher may mask an icon to
     * a circle or a squircle and cut whatever reaches the edge; `maskable` is
     * how a platform is told which artwork survives that. Declaring one icon
     * as both would leave the platform to guess.
     */
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
