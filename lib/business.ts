/**
 * The business core's vocabulary: what a field may contain, what a value means
 * once normalized, and what every list can be filtered by.
 *
 * No database import, so a form and the server that receives it can share one
 * definition and cannot drift apart — the same arrangement `lib/contact.ts`
 * has held since Build 001. The limits here mirror the CHECK constraints in
 * `lib/db/schema.ts`: the database is the backstop, this is the part that can
 * explain itself to a person.
 */

import {
  CLIENT_ACCOUNT_TYPES,
  CLIENT_STATUSES,
  LEAD_SOURCES,
  LEAD_STAGES,
  PROJECT_STATUSES,
  type ClientAccountType,
  type ClientStatus,
  type LeadSource,
  type LeadStage,
  type ProjectStatus,
} from "./db/schema.ts";
import { readWallTime, type WallTimeRefusal } from "./studio-format.ts";

/* ------------------------------------------------------------------ limits */

export const LIMITS = {
  name: 160,
  email: 254,
  phone: 40,
  title: 120,
  role: 120,
  website: 300,
  notes: 4000,
  summary: 4000,
  description: 4000,
  nextStep: 500,
  lostReason: 500,
  search: 120,
} as const;

/* ------------------------------------------------------------- normalizing */

/** Collapses the whitespace people paste in, and caps the length. */
export function text(value: FormDataEntryValue | null | undefined, max: number): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Keeps newlines — notes are written in paragraphs — but trims and caps. */
export function multiline(value: FormDataEntryValue | null | undefined, max: number): string {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, max);
}

export function optional(value: string): string | null {
  return value.length > 0 ? value : null;
}

/** What duplicate detection compares. Never what is displayed. */
export function normalizeEmail(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `https://www.Example.co.uk/work` → `example.co.uk`. Used only to notice that
 * two clients may be the same company; never shown in place of the website.
 */
export function normalizeDomain(website: string | null | undefined): string | null {
  const raw = String(website ?? "").trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const host = new URL(withScheme).hostname.toLowerCase();
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmail(value: string): boolean {
  return EMAIL.test(value) && value.length <= LIMITS.email;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rejects an id before it reaches a query, so a bad one is a 404 and not a 500. */
export function isId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** A form field that should hold an id, or nothing at all. */
export function optionalId(value: FormDataEntryValue | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  return isId(raw) ? raw : null;
}

/** `2026-09-15` from a date input, or null. Stored as a date, not an instant. */
export function optionalDate(value: FormDataEntryValue | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(raw)) ? raw : null;
}

/**
 * A `datetime-local` value, read as **New York wall-clock time** — the instant
 * to store, null for an empty field, or the sentence a person reads when the
 * time cannot be one.
 *
 * It used to be `new Date(raw)`, which reads a zoneless string in the server
 * process's zone — UTC on Railway — so a follow-up typed in New York was stored
 * four or five hours early, and moved again every time the form was saved.
 * The rule now lives in `readWallTime`, independent of any process or browser.
 */
export function optionalMoment(
  value: FormDataEntryValue | null | undefined,
): { ok: true; value: Date | null } | { ok: false; message: string } {
  const read = readWallTime(typeof value === "string" ? value : "");
  if (read.ok) return read;
  return { ok: false, message: WALL_TIME_MESSAGES[read.reason] };
}

/** Why a typed time cannot be kept — in words, never in zones or offsets. */
const WALL_TIME_MESSAGES: Record<WallTimeRefusal, string> = {
  malformed: "That is not a date and time. Choose one from the calendar.",
  nonexistent: "That time does not happen in New York — the clocks go forward then. Choose another time.",
  ambiguous: "That time happens twice in New York — the clocks go back then. Choose a different time.",
};

/* --------------------------------------------------------------- vocabulary */

function member<T extends string>(values: readonly T[], fallback: T) {
  return (value: FormDataEntryValue | null | undefined): T => {
    const raw = String(value ?? "");
    return (values as readonly string[]).includes(raw) ? (raw as T) : fallback;
  };
}

export const readAccountType = member<ClientAccountType>(CLIENT_ACCOUNT_TYPES, "organization");
export const readClientStatus = member<ClientStatus>(CLIENT_STATUSES, "active");
export const readLeadStage = member<LeadStage>(LEAD_STAGES, "new");
export const readLeadSource = member<LeadSource>(LEAD_SOURCES, "manual");
export const readProjectStatus = member<ProjectStatus>(PROJECT_STATUSES, "planned");

/** How a value is written where a person reads it. */
export const LABELS: Record<string, string> = {
  organization: "Organization",
  individual: "Individual",
  active: "Active",
  inactive: "Inactive",
  new: "New",
  discovery: "Discovery",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
  inquiry: "Inquiry",
  referral: "Referral",
  existing_client: "Existing client",
  manual: "Manual",
  other: "Other",
  planned: "Planned",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function label(value: string | null | undefined): string {
  if (!value) return "—";
  return LABELS[value] ?? value;
}

/**
 * The version a form was composed against, passed back so the save can be
 * refused if somebody else got there first. Zero is never a real version, so an
 * absent or mangled field loses the race rather than winning it by accident.
 */
export function readVersion(value: FormDataEntryValue | null | undefined): number {
  const version = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(version) && version > 0 ? version : 0;
}

/* ------------------------------------------------------------------ paging */

export const PAGE_SIZE = 25;

export function readPage(value: string | undefined): number {
  const page = Number.parseInt(String(value ?? "1"), 10);
  return Number.isFinite(page) && page > 0 ? Math.min(page, 400) : 1;
}
