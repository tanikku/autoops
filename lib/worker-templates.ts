import type { RoutineFrequency } from "@/types";

/**
 * Starting values for the hire form.
 *
 * **A template can only describe what a worker can actually do.** A worker is
 * one call to a model with the prompt it holds — there is no browsing, no
 * inbox, no calendar, and no memory of what it produced last time. Anything a
 * template offers has to be something the model can do with the words in front
 * of it, and everything else has to come from the person who writes the prompt.
 *
 * That is why each of these has a place to paste the material in. The earlier
 * versions read as though AutoOps would go and find it — "today's important
 * news", "the unanswered emails in my inbox", "research the topic I am
 * tracking, with sources" — and a run that produced something anyway was
 * recorded as a success, because nothing in the pipeline can tell an answer
 * from an invention.
 *
 * **They start on `manual` for the same reason.** The material is part of the
 * prompt, so a run repeats what was pasted rather than picking up anything
 * new; running one on a cadence would bill the model daily to say the same
 * thing. A schedule earns its place when the output depends on the date, and
 * a worker whose prompt carries its own input is not that.
 */
export type WorkerTemplate = {
  id: string;
  name: string;
  description: string;
  defaultPrompt: string;
  defaultFrequency: RoutineFrequency;
};

export const workerTemplates: WorkerTemplate[] = [
  {
    id: "news-reporter",
    name: "News Reporter",
    description: "Turns headlines or articles you paste in into a short briefing.",
    defaultPrompt: `Today is {{today}}.

Write a short briefing from the articles below: the three or four things that matter most, one sentence each, then anything worth watching.

Use only what is written below. If something is unclear, say so rather than filling it in.

--- ARTICLES ---
(paste headlines or article text here)`,
    defaultFrequency: "manual",
  },
  {
    id: "x-post-writer",
    name: "X Post Writer",
    description: "Turns an update you paste in into a few short social posts.",
    defaultPrompt: `Write three X posts about the update below. Keep each under 280 characters, avoid hashtags, and give each one a different angle so they are not three versions of the same sentence.

Use only what is written below.

--- UPDATE ---
(paste your announcement, release notes or changelog here)`,
    defaultFrequency: "manual",
  },
  {
    id: "email-assistant",
    name: "Email Assistant",
    description: "Drafts replies to emails you paste in.",
    defaultPrompt: `Draft a reply to each email below. Keep each under 150 words, match the tone of the message it answers, and separate the drafts with a blank line.

Use only what is written below. Where a reply needs something that is not there, leave a clearly marked gap instead of inventing it.

--- EMAILS ---
(paste the emails you need to answer here)`,
    defaultFrequency: "manual",
  },
  {
    id: "meeting-assistant",
    name: "Meeting Assistant",
    description:
      "Turns meeting notes you paste in into decisions and action items.",
    defaultPrompt: `Turn the notes below into three sections: decisions made, action items with an owner for each, and open questions.

Use only what is written below. If an action item has no clear owner, put it under open questions rather than guessing.

--- NOTES ---
(paste your meeting notes or transcript here)`,
    defaultFrequency: "manual",
  },
  {
    id: "research-analyst",
    name: "Research Analyst",
    description: "Compares two versions of your notes and reports what changed.",
    defaultPrompt: `Generated at {{now}}.

Compare the two sets of notes below and report what changed: what is new, what has gone, and what is still there but reads differently. Finish with a short conclusion.

Use only what is written below. Do not add anything from elsewhere.

--- EARLIER ---
(paste the earlier version here)

--- CURRENT ---
(paste the current version here)`,
    defaultFrequency: "manual",
  },
];
