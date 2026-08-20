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
}));

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/users", () => ({ getUserTimezone: mocks.getUserTimezone }));

const NewRoutinePage = (await import("@/app/dashboard/new/page")).default;

/** The zone as it was handed to whichever component was given one. */
function passedTimezone(node: ReactNode): unknown {
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

    if ("timezone" in props) {
      found = props.timezone;
      return;
    }

    walk(props.children);
  };

  walk(node);
  return found;
}

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue("user-1");
  mocks.getUserTimezone.mockReset().mockResolvedValue("Asia/Tokyo");
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
