import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

/**
 * What an install dialog is told, and whether the files it names are really
 * there.
 *
 * **The two halves matter for different reasons.** The values decide what
 * somebody sees when they install Koqentra and where it opens afterwards — and
 * two of them, `id` and `scope`, are the kind of mistake nobody notices until
 * installed copies are already in the wild. The files are checked because a
 * manifest naming an icon that 404s is worse than no manifest: the browser
 * simply refuses to offer installation, with nothing in the product to say so.
 *
 * **The dimensions are read out of the PNG itself**, not trusted from the
 * `sizes` string beside them. A 512 declared where a 192 sits is exactly the
 * error a string comparison cannot see, and reading four bytes of a header
 * needs no image library.
 */

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Width and height out of a PNG's IHDR, or a failure naming the file. */
function pngSize(relativePath: string): { width: number; height: number } {
  const bytes = readFileSync(join(repositoryRoot, relativePath));

  // Signature, then the first chunk, which the format requires to be IHDR.
  expect(bytes.subarray(0, 8).toString("hex"), `${relativePath} is not a PNG`).toBe(
    "89504e470d0a1a0a",
  );
  expect(bytes.subarray(12, 16).toString("ascii"), `${relativePath} has no IHDR`).toBe(
    "IHDR",
  );

  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const built = manifest();

describe("what an install dialog is told", () => {
  it("names the product, twice, with nothing invented for the short form", () => {
    expect(built.name).toBe("Koqentra");
    expect(built.short_name).toBe("Koqentra");
  });

  /** The same sentence the root metadata leads with, word for word. */
  it("describes it the way the product already describes itself", () => {
    expect(built.description).toBe(
      "Evaluate content for X, Reddit, and long-form, get drafts for what is worth using, and keep the final decision with you.",
    );
  });

  /**
   * **An identity that outlives the launch screen.** Without `id`, a browser
   * identifies an installed app by `start_url` — so moving the start screen
   * later would orphan every installation. This is the assertion that catches
   * somebody "simplifying" it away.
   */
  it("keeps an identity of its own, separate from where it opens", () => {
    expect(built.id).toBe("/");
    expect(built.id).not.toBe(built.start_url);
  });

  it("opens on Creator", () => {
    expect(built.start_url).toBe("/creator");
  });

  /**
   * Settings, Workers and the privacy notice are all outside `/creator`. A
   * scope narrower than the site would eject somebody to a browser tab the
   * first time they opened one of them.
   */
  it("covers the whole product, not just the screen it opens on", () => {
    expect(built.scope).toBe("/");
  });

  it("asks for a window of its own", () => {
    expect(built.display).toBe("standalone");
  });

  it("uses the background the application already paints", () => {
    expect(built.background_color).toBe("#ffffff");
    expect(built.theme_color).toBe("#ffffff");
  });

  /**
   * **Nothing beyond installability.** Shortcuts, share targets and file
   * handlers are product behaviour rather than packaging; each would be a
   * surface to design, test and support, and none is needed to install.
   */
  it("claims no capability this phase did not build", () => {
    for (const key of [
      "shortcuts",
      "share_target",
      "file_handlers",
      "protocol_handlers",
      "screenshots",
      "categories",
      "orientation",
      "display_override",
      "launch_handler",
      "related_applications",
      "prefer_related_applications",
    ] as const) {
      expect(built[key]).toBeUndefined();
    }
  });
});

describe("the icons it names", () => {
  it("offers exactly the three that were approved", () => {
    expect(built.icons).toEqual([
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ]);
  });

  /**
   * **Chromium will not offer installation without both.** 192 and 512 at
   * `purpose: "any"` are the minimum it looks for; a manifest missing either
   * fails silently, with the install option simply absent.
   */
  it.each(["192x192", "512x512"])("includes a %s icon for any purpose", (sizes) => {
    expect(
      built.icons?.some((icon) => icon.sizes === sizes && icon.purpose === "any"),
    ).toBe(true);
  });

  it("marks exactly one icon as maskable", () => {
    expect(built.icons?.filter((icon) => icon.purpose === "maskable")).toHaveLength(1);
  });

  /**
   * A manifest naming a missing icon is worse than no manifest: installation is
   * refused, and nothing in the product says why.
   */
  it.each([
    ["/icon-192.png", 192],
    ["/icon-512.png", 512],
    ["/icon-maskable-512.png", 512],
  ])("really has %s at the size it claims", (src, expected) => {
    // Everything the manifest names is served from `public/` at the site root.
    const size = pngSize(join("public", src));

    expect(size).toEqual({ width: expected, height: expected });
  });
});

/**
 * **Apple reads a link tag, not the manifest.** iOS has historically taken the
 * Home Screen icon from `apple-touch-icon`, and Next.js emits that link only
 * because this exact file exists at this exact path — there is no import to
 * break loudly if it is moved or renamed.
 */
describe("the Home Screen icon Apple looks for", () => {
  it("sits where the framework expects it, at 180x180", () => {
    expect(pngSize(join("app", "apple-icon.png"))).toEqual({
      width: 180,
      height: 180,
    });
  });
});
