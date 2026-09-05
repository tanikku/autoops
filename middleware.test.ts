import { describe, expect, it, vi } from "vitest";

/**
 * Which routes the middleware runs on.
 *
 * **Only the matcher.** Whether the session check itself works is `auth.ts`'s
 * question and is not re-asked here; what this fixes is the list, because a
 * route missing from it is a signed-in area with no guard in front of it and
 * nothing else would notice.
 *
 * `auth` is replaced so importing this file does not pull a framework runtime
 * in to read one array.
 */
vi.mock("@/auth", () => ({ auth: vi.fn() }));

const { config } = await import("@/middleware");

describe("the protected routes", () => {
  it("covers the dashboard and everything under it", () => {
    expect(config.matcher).toContain("/dashboard/:path*");
  });

  it("covers Creator and everything under it", () => {
    expect(config.matcher).toContain("/creator/:path*");
  });

  /**
   * **The landing page and the privacy notice stay public.** The second
   * deliberately: a notice only account holders can read is not much of one,
   * and it is what somebody is pointed at *before* they hand anything over.
   */
  it("leaves the public pages public", () => {
    expect(config.matcher).not.toContain("/");
    expect(config.matcher).not.toContain("/privacy");
    expect(config.matcher).not.toContain("/privacy/:path*");
  });

  it("guards exactly those two areas", () => {
    expect(config.matcher).toEqual(["/dashboard/:path*", "/creator/:path*"]);
  });
});
