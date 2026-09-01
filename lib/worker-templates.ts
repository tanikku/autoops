import type { TranslationKey } from "@/lib/i18n";
import type { RoutineFrequency, RoutineKind } from "@/types";

/**
 * Starting values for the hire form.
 *
 * **A template can only describe what a worker can actually do**, and the two
 * kinds can do different things. A website worker fetches one address it was
 * given, compares it with what it saw last time, and asks a model about the
 * difference; a prompt worker is one call to a model with the words it holds.
 * Neither browses, searches, reads an inbox, or remembers what it produced
 * before.
 *
 * That boundary is what every example here is written against. An earlier set
 * read as though AutoOps would go and find things — "today's important news",
 * "the unanswered emails in my inbox" — and a run that produced something
 * anyway was recorded as a success, because nothing in the pipeline can tell an
 * answer from an invention. So a **website** example never suggests searching
 * or collecting from anywhere but the one page, and a **prompt** example always
 * carries the place where its material is written in.
 *
 * **The words live in the dictionary, all three of them.** A template's name
 * and prompt do become the account's own material once it is applied — but
 * until then they are AutoOps offering an example, and an example nobody can
 * read is not one. What is never translated is anything written *after* a
 * template is applied. This reverses the earlier position that a template's
 * name and prompt stay as written; see the report for that sprint.
 *
 * **Frequency is per kind, and the reason is not the same for both.** A website
 * worker earns a cadence: it looks at a page that changes on its own, and the
 * model is only involved when something did. A prompt worker's material is part
 * of its prompt, so a cadence re-asks the same question — the three here are on
 * one anyway because each is written around a standing theme rather than around
 * something pasted in for a single run. Every worker still starts as a `draft`,
 * so nothing runs until somebody turns it on.
 */
export type WorkerTemplate = {
  id: string;
  /**
   * What applying this template makes.
   *
   * **New, and it is what lets a template offer a watcher at all.** Before it,
   * every template was a prompt worker by construction and the list was hidden
   * whenever the website kind was chosen. Applying one now sets the kind, the
   * same way applying an AI draft already did.
   */
  kind: RoutineKind;
  nameKey: TranslationKey;
  descriptionKey: TranslationKey;
  /**
   * What goes in the instructions field.
   *
   * For a website worker that is what to do about a change that has already
   * been found; for a prompt worker it is the whole of the job. The two read
   * differently for that reason, and the form labels the field differently too.
   */
  promptKey: TranslationKey;
  defaultFrequency: RoutineFrequency;
};

/**
 * The examples, in the order the hire page offers them.
 *
 * **Website first**, because watching a page is the thing AutoOps does that a
 * person cannot easily do by hand every morning, and it is what the Closed Beta
 * is trying to learn about. The prompt examples follow rather than disappear:
 * which group gets used is itself the question.
 *
 * **No template carries an address.** Which page to watch is the one thing only
 * the person choosing can know, so a website template fills in everything
 * except that and leaves the field empty for them.
 */
export const workerTemplates: WorkerTemplate[] = [
  {
    id: "municipal-notices",
    kind: "website",
    nameKey: "template.municipalNotices.name",
    descriptionKey: "template.municipalNotices.description",
    promptKey: "template.municipalNotices.prompt",
    defaultFrequency: "daily",
  },
  {
    id: "product-page",
    kind: "website",
    nameKey: "template.productPage.name",
    descriptionKey: "template.productPage.description",
    promptKey: "template.productPage.prompt",
    defaultFrequency: "daily",
  },
  {
    id: "careers-page",
    kind: "website",
    nameKey: "template.careersPage.name",
    descriptionKey: "template.careersPage.description",
    promptKey: "template.careersPage.prompt",
    defaultFrequency: "daily",
  },
  {
    id: "news-page",
    kind: "website",
    nameKey: "template.newsPage.name",
    descriptionKey: "template.newsPage.description",
    promptKey: "template.newsPage.prompt",
    defaultFrequency: "daily",
  },
  {
    id: "grant-info",
    kind: "website",
    nameKey: "template.grantInfo.name",
    descriptionKey: "template.grantInfo.description",
    promptKey: "template.grantInfo.prompt",
    defaultFrequency: "daily",
  },
  {
    id: "daily-work-plan",
    kind: "prompt",
    nameKey: "template.dailyWorkPlan.name",
    descriptionKey: "template.dailyWorkPlan.description",
    promptKey: "template.dailyWorkPlan.prompt",
    defaultFrequency: "daily",
  },
  {
    id: "idea-generator",
    kind: "prompt",
    nameKey: "template.ideaGenerator.name",
    descriptionKey: "template.ideaGenerator.description",
    promptKey: "template.ideaGenerator.prompt",
    defaultFrequency: "weekly",
  },
  {
    id: "recurring-report",
    kind: "prompt",
    nameKey: "template.recurringReport.name",
    descriptionKey: "template.recurringReport.description",
    promptKey: "template.recurringReport.prompt",
    defaultFrequency: "weekly",
  },
];

/**
 * The examples of one kind, in order.
 *
 * **A filter rather than two lists.** One array is still what a template
 * belongs to, so adding an example is one entry and cannot end up in a group
 * nobody renders — which is what two hand-kept lists would eventually produce.
 */
export function templatesOfKind(kind: RoutineKind): WorkerTemplate[] {
  return workerTemplates.filter((template) => template.kind === kind);
}
