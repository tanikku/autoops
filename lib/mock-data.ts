import type { Routine } from "@/types";

export const mockRoutines: Routine[] = [
  {
    id: "daily-website-update",
    name: "Daily Website Update",
    schedule: "Every day at 07:00",
    status: "active",
  },
  {
    id: "weekly-summary",
    name: "Weekly Summary",
    schedule: "Every Friday at 18:00",
    status: "paused",
  },
  {
    id: "generate-release-notes",
    name: "Generate Release Notes",
    schedule: "Manual",
    status: "draft",
  },
];
