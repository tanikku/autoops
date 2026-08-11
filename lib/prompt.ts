export type PromptVariables = Record<string, string>;

const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

/** Values available to every prompt at run time. */
export function promptVariables(at: Date = new Date()): PromptVariables {
  return {
    today: at.toISOString().slice(0, 10),
    now: at.toISOString(),
  };
}

/**
 * Replaces `{{name}}` placeholders. Unknown names are left as-is.
 *
 * **Own properties only.** `in` would have answered for the whole prototype
 * chain, so `{{constructor}}` and `{{toString}}` were substituted with
 * whatever `Object.prototype` holds under that name — a function, stringified
 * into the prompt — while the documented behaviour is to leave an unrecognised
 * name exactly where it is. The variables are the two put there deliberately,
 * and nothing a plain object happens to inherit is one of them.
 */
export function renderPrompt(
  template: string,
  variables: PromptVariables,
): string {
  return template.replace(VARIABLE_PATTERN, (match, name: string) =>
    Object.hasOwn(variables, name) ? variables[name] : match,
  );
}
