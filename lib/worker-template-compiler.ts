import { t, type TranslationKey } from "@/lib/i18n";

/**
 * The Public Beta watch templates, turned into an ordinary website worker.
 *
 * **The server's answer, never the form's.** A template submission carries the
 * person's answers — a URL, a date, a product — and nothing else is read from
 * it: the instructions, the condition and the kind are written here, so a form
 * edited to carry a different prompt still produces exactly this worker.
 *
 * **Pure.** No database, no clock, no request: today's date is handed in, so the
 * same answers always compile to the same worker and every branch is a unit
 * test. The wording follows the conditions evaluated against the model; a
 * change to any of it is a change to what was measured.
 */

/** The only template identifiers a worker can be created with. */
export const watchTemplateIds = ["hotel-availability", "product-restock"] as const;

export type WatchTemplateId = (typeof watchTemplateIds)[number];

export function isWatchTemplateId(value: string): value is WatchTemplateId {
  return (watchTemplateIds as readonly string[]).includes(value);
}

/** The cadences a template worker may run on; the default comes first. */
export const watchTemplateFrequencies = ["every-6-hours", "every-3-hours", "daily"] as const;

export const watchTemplateLimits = {
  room: 100,
  notes: 500,
  product: 80,
  variant: 100,
  maxPrice: 99_999_999,
} as const;

/** What a template form submits, read as text and trimmed. */
export type WatchTemplateValues = {
  websiteUrl: string;
  name: string;
  notes: string;
  stayDate: string;
  room: string;
  maxPrice: string;
  product: string;
  variant: string;
  includePreorder: string;
};

export type WatchTemplateField = Exclude<keyof WatchTemplateValues, "websiteUrl" | "name">;

export type WatchTemplateErrors = Partial<Record<WatchTemplateField, string>>;

/** The parts of a worker a template decides. Everything else is the form's. */
export type CompiledWatchWorker = {
  templateId: WatchTemplateId;
  kind: "website";
  websiteUrl: string;
  name: string;
  prompt: string;
  targetCondition: string;
};

export type WatchTemplateCompilation =
  | { ok: true; worker: CompiledWatchWorker }
  | { ok: false; errors: WatchTemplateErrors };

/** A calendar date, as the account's time zone sees it. */
export type CalendarDate = { year: number; month: number; day: number };

const valueFields: (keyof WatchTemplateValues)[] = [
  "websiteUrl",
  "name",
  "notes",
  "stayDate",
  "room",
  "maxPrice",
  "product",
  "variant",
  "includePreorder",
];

export function readWatchTemplateValues(formData: FormData): WatchTemplateValues {
  const values = {} as WatchTemplateValues;
  for (const field of valueFields) {
    values[field] = String(formData.get(field) ?? "").trim();
  }
  return values;
}

export function compileWatchTemplate(
  templateId: WatchTemplateId,
  values: WatchTemplateValues,
  context: { language: string; today: CalendarDate },
): WatchTemplateCompilation {
  return templateId === "hotel-availability"
    ? compileHotelTemplate(values, context)
    : compileRestockTemplate(values, context);
}

export function compileHotelTemplate(
  values: WatchTemplateValues,
  { language, today }: { language: string; today: CalendarDate },
): WatchTemplateCompilation {
  const errors: WatchTemplateErrors = {};
  const stay = readStayDate(values.stayDate, today, language);
  if (typeof stay === "string") {
    errors.stayDate = stay;
  }
  tooLong(errors, "room", values.room, "template.hotel.field.room", language);
  tooLong(errors, "notes", values.notes, "template.field.notes", language);
  const maxPrice = readMaxPrice(values.maxPrice);
  if (maxPrice === "invalid") {
    errors.maxPrice = t(language, "template.validation.maxPriceInvalid");
  }

  if (typeof stay === "string" || maxPrice === "invalid" || Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const date = t(language, "template.date", {
    month: stay.month,
    day: stay.day,
    monthName: MONTH_NAMES[stay.month - 1],
  });
  const room = values.room;
  const price =
    maxPrice === null
      ? null
      : t(language, "template.price", { amount: maxPrice.toLocaleString("en-US") });

  const prompt = [
    t(language, "template.hotel.prompt.base", { date }),
    room ? t(language, "template.hotel.prompt.room", { room }) : null,
    price ? t(language, "template.hotel.prompt.price", { price }) : null,
    values.notes ? t(language, "template.prompt.notes", { notes: values.notes }) : null,
  ];

  const targetCondition = room
    ? price
      ? t(language, "template.hotel.condition.roomPrice", { date, room, price })
      : t(language, "template.hotel.condition.room", { date, room })
    : price
      ? t(language, "template.hotel.condition.price", { date, price })
      : t(language, "template.hotel.condition.date", { date });

  return {
    ok: true,
    worker: {
      templateId: "hotel-availability",
      kind: "website",
      websiteUrl: values.websiteUrl,
      name: values.name || t(language, "template.hotel.defaultName", { date }),
      prompt: joinLines(prompt),
      targetCondition,
    },
  };
}

export function compileRestockTemplate(
  values: WatchTemplateValues,
  { language }: { language: string },
): WatchTemplateCompilation {
  const errors: WatchTemplateErrors = {};
  if (values.product === "") {
    errors.product = t(language, "template.validation.productRequired");
  }
  tooLong(errors, "product", values.product, "template.restock.field.product", language);
  tooLong(errors, "variant", values.variant, "template.restock.field.variant", language);
  tooLong(errors, "notes", values.notes, "template.field.notes", language);
  // A checkbox: absent means no, and the only other answer it sends is "true".
  if (values.includePreorder !== "" && values.includePreorder !== "true") {
    errors.includePreorder = t(language, "template.validation.includePreorderInvalid");
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const product = values.product;
  const variant = values.variant;
  const includePreorder = values.includePreorder === "true";

  const prompt = [
    t(language, "template.restock.prompt.base", { product }),
    variant ? t(language, "template.restock.prompt.variant", { variant }) : null,
    t(
      language,
      includePreorder
        ? "template.restock.prompt.preorderIncluded"
        : "template.restock.prompt.preorderExcluded",
    ),
    values.notes ? t(language, "template.prompt.notes", { notes: values.notes }) : null,
  ];

  const targetCondition = includePreorder
    ? `${
        variant
          ? t(language, "template.restock.condition.variant", { product, variant })
          : t(language, "template.restock.condition.basic")
      }${t(language, "template.restock.condition.preorderIncluded")}`
    : variant
      ? t(language, "template.restock.condition.variantNoPreorder", { product, variant })
      : t(language, "template.restock.condition.noPreorder", { product });

  return {
    ok: true,
    worker: {
      templateId: "product-restock",
      kind: "website",
      websiteUrl: values.websiteUrl,
      name: values.name || t(language, "template.restock.defaultName", { product }),
      prompt: joinLines(prompt),
      targetCondition,
    },
  };
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A stay date as a calendar date, or the message saying what is wrong with it. */
function readStayDate(
  raw: string,
  today: CalendarDate,
  language: string,
): CalendarDate | string {
  if (raw === "") {
    return t(language, "template.validation.stayDateRequired");
  }
  const match = DATE_PATTERN.exec(raw);
  if (!match) {
    return t(language, "template.validation.stayDateInvalid");
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const real = new Date(Date.UTC(year, month - 1, day));
  if (
    real.getUTCFullYear() !== year ||
    real.getUTCMonth() !== month - 1 ||
    real.getUTCDate() !== day
  ) {
    return t(language, "template.validation.stayDateInvalid");
  }
  if (compareDates({ year, month, day }, today) < 0) {
    return t(language, "template.validation.stayDatePast");
  }
  return { year, month, day };
}

function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/** The price limit, null when none was given, or "invalid". */
function readMaxPrice(raw: string): number | null | "invalid" {
  if (raw === "") {
    return null;
  }
  if (!/^\d+$/.test(raw)) {
    return "invalid";
  }
  const value = Number(raw);
  return value >= 1 && value <= watchTemplateLimits.maxPrice ? value : "invalid";
}

function tooLong(
  errors: WatchTemplateErrors,
  field: "room" | "notes" | "product" | "variant",
  value: string,
  labelKey: TranslationKey,
  language: string,
): void {
  const limit = watchTemplateLimits[field];
  if (!errors[field] && value.length > limit) {
    errors[field] = t(language, "worker.validation.tooLong", {
      label: t(language, labelKey),
      limit: limit.toLocaleString("en-US"),
    });
  }
}

function joinLines(lines: (string | null)[]): string {
  return lines.filter((line): line is string => line !== null).join("\n");
}
