import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * The hire form has to be told which clock it is scheduling against.
 *
 * It is a client component, so it cannot read the account row itself — the zone
 * has to be handed to it here. If this page stopped passing it, the form would
 * still render and would simply stop naming the zone, which is the state that
 * produced a worker scheduled nine hours away from where its owner meant.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  getUserTimezone: vi.fn(),
  getUserLanguage: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/users", () => ({
  getUserTimezone: mocks.getUserTimezone,
  getUserLanguage: mocks.getUserLanguage,
}));

const NewRoutinePage = (await import("@/app/dashboard/new/page")).default;

/** One prop, as it was handed to whichever component was given it. */
function passedProp(node: ReactNode, name: string): unknown {
  let found: unknown;

  const walk = (current: unknown): void => {
    if (found !== undefined) {
      return;
    }

    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }

    if (!current || typeof current !== "object") {
      return;
    }

    const props = (current as { props?: Record<string, unknown> }).props;
    if (!props) {
      return;
    }

    if (name in props) {
      found = props[name];
      return;
    }

    walk(props.children);
  };

  walk(node);
  return found;
}

const passedTimezone = (node: ReactNode) => passedProp(node, "timezone");

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue("user-1");
  mocks.getUserTimezone.mockReset().mockResolvedValue("Asia/Tokyo");
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
});

describe("hire worker page", () => {
  it("hands the account's timezone to the form", async () => {
    expect(passedTimezone(await NewRoutinePage())).toBe("Asia/Tokyo");
  });

  it("reads it for the signed-in account", async () => {
    await NewRoutinePage();

    expect(mocks.getUserTimezone).toHaveBeenCalledWith("user-1");
  });

  it("passes UTC through unchanged when that is what the account is on", async () => {
    mocks.getUserTimezone.mockResolvedValue("UTC");

    expect(passedTimezone(await NewRoutinePage())).toBe("UTC");
  });
});

/**
 * The form has to be told which language it is written in, for the same reason
 * it has to be told the zone: it is a client component, and both live on the
 * account row.
 */
describe("the language the hire form is written in", () => {
  it("comes from the account", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    expect(passedProp(await NewRoutinePage(), "language")).toBe("ja");
  });

  it("is read for the signed-in account", async () => {
    await NewRoutinePage();

    expect(mocks.getUserLanguage).toHaveBeenCalledWith("user-1");
  });
});
