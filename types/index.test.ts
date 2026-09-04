import { describe, expect, it } from "vitest";
import {
  creatorFeedbackActions,
  creatorSourceKinds,
  creatorTargetChannels,
  editorialVerdicts,
  isCreatorFeedbackAction,
  isCreatorSourceKind,
  isCreatorTargetChannel,
  isEditorialVerdict,
  isRoutineKind,
  routineKinds,
} from "@/types";

/**
 * The guards standing between a stored string and the code that reads it.
 *
 * Every Creator column is a plain `String` in the schema, exactly as
 * `Routine.kind` and `status` are, so the database will accept whatever is
 * written to it. **These four functions are the whole of the narrowing**, which
 * makes their value sets worth fixing rather than leaving to whoever edits the
 * list next.
 *
 * The last block is the one that matters most and tests nothing new: it fixes
 * what did *not* change.
 */

const guards = [
  ["source kind", creatorSourceKinds, isCreatorSourceKind, ["text", "url"]],
  [
    "target channel",
    creatorTargetChannels,
    isCreatorTargetChannel,
    ["x", "reddit", "longform"],
  ],
  ["verdict", editorialVerdicts, isEditorialVerdict, ["recommend", "skip"]],
  [
    "feedback action",
    creatorFeedbackActions,
    isCreatorFeedbackAction,
    ["approve", "edit", "reject"],
  ],
] as const satisfies readonly (readonly [
  string,
  readonly string[],
  (value: string) => boolean,
  readonly string[],
])[];

describe.each(guards)("%s", (_name, values, guard, expected) => {
  it("holds exactly the values this release defines", () => {
    expect([...values]).toEqual([...expected]);
  });

  it.each([...values])("accepts %o", (value) => {
    expect(guard(value)).toBe(true);
  });

  /**
   * A guard that says yes to everything narrows nothing. The whitespace case
   * is the one that actually happens: a value arrives padded and would pass a
   * comparison written with `trim` on only one side.
   */
  it.each(["", " ", "Text", "X", "SKIP", "approve ", "unknown", "null"])(
    "rejects %o",
    (value) => {
      expect(guard(value)).toBe(false);
    },
  );
});

describe("what the Creator vocabulary deliberately does not touch", () => {
  /**
   * **The decision this whole domain rests on.** Creator work is not a kind of
   * worker: `isRoutineKind` promises that every value it accepts has an
   * execution branch behind it, and a `"creator"` in this list would be a
   * promise nothing keeps. Adding one is a compile-clean change that fails only
   * at run time, which is why it is fixed here.
   */
  it("leaves RoutineKind at prompt and website", () => {
    expect([...routineKinds]).toEqual(["prompt", "website"]);
    expect(isRoutineKind("creator")).toBe(false);
  });

  /** The channels are their own vocabulary and must not leak into the other. */
  it.each([...creatorTargetChannels])(
    "does not make the channel %o a routine kind",
    (channel) => {
      expect(isRoutineKind(channel)).toBe(false);
    },
  );

  /**
   * `skip` and `reject` sit next to each other and mean different things — one
   * is what the model decided, the other is what the person thought of the
   * decision. Keeping the two lists disjoint is what stops them being read as
   * one vocabulary.
   */
  it("keeps verdicts and feedback actions disjoint", () => {
    const overlap = editorialVerdicts.filter((verdict) =>
      (creatorFeedbackActions as readonly string[]).includes(verdict),
    );

    expect(overlap).toEqual([]);
  });
});
