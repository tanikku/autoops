import type { RoutineFrequency } from "@/types";

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
    description: "Summarises the day's headlines for your industry.",
    defaultPrompt:
      "Today's date is {{today}}.\n\nSummarize today's important news.",
    defaultFrequency: "daily",
  },
  {
    id: "x-post-writer",
    name: "X Post Writer",
    description: "Drafts short social posts from your recent updates.",
    defaultPrompt:
      "Write three X posts about our latest product updates. Keep each under 280 characters and avoid hashtags.",
    defaultFrequency: "daily",
  },
  {
    id: "email-assistant",
    name: "Email Assistant",
    description: "Turns your inbox backlog into ready-to-send replies.",
    defaultPrompt:
      "Draft replies to the unanswered emails in my inbox. Match my usual tone and keep each reply under 150 words.",
    defaultFrequency: "daily",
  },
  {
    id: "meeting-assistant",
    name: "Meeting Assistant",
    description: "Converts meeting notes into decisions and action items.",
    defaultPrompt:
      "Turn my meeting notes into a summary with decisions made, action items, and owners.",
    defaultFrequency: "weekly",
  },
  {
    id: "research-analyst",
    name: "Research Analyst",
    description: "Digs into a topic and reports what changed.",
    defaultPrompt:
      "Generated at {{now}}.\n\nResearch the topic I am tracking and report what changed since the last run, with sources and a short conclusion.",
    defaultFrequency: "monthly",
  },
];
