export type PromptVariables = Record<string, string>;

const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

/** Values available to every prompt at run time. */
export function promptVariables(at: Date = new Date()): PromptVariables {
  return {
    today: at.toISOString().slice(0, 10),
    now: at.toISOString(),
  };
}

/** Replaces `{{name}}` placeholders. Unknown names are left as-is. */
export function renderPrompt(
  template: string,
  variables: PromptVariables,
): string {
  return template.replace(VARIABLE_PATTERN, (match, name: string) =>
    name in variables ? variables[name] : match,
  );
}
