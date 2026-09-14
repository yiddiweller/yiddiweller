export const LIMITS = {
  name: 100,
  email: 254,
  message: 4000,
} as const;

export type ContactFields = {
  name: string;
  email: string;
  message: string;
};

export type FieldErrors = Partial<Record<keyof ContactFields, string>>;

/** Deliberately permissive: shape only, delivery is the real test. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validate(fields: ContactFields): FieldErrors {
  const errors: FieldErrors = {};
  const name = fields.name.trim();
  const email = fields.email.trim();
  const message = fields.message.trim();

  if (!name) errors.name = "Please add your name.";
  else if (name.length > LIMITS.name) errors.name = "That name is too long.";

  if (!email) errors.email = "Please add your email.";
  else if (email.length > LIMITS.email || !EMAIL.test(email))
    errors.email = "Please check your email address.";

  if (!message) errors.message = "Please add a message.";
  else if (message.length > LIMITS.message) errors.message = "That message is too long.";

  return errors;
}

/**
 * The complete set of keys the contact endpoint accepts. `reference` is the
 * honeypot. Anything else is rejected rather than ignored, so a caller cannot
 * probe for fields the endpoint might one day read.
 */
const ALLOWED_KEYS = new Set(["name", "email", "message", "reference"]);

/**
 * Hard ceiling on the raw request body, checked before parsing. The field
 * limits above cap what is stored; this caps what has to be read into memory
 * to find that out.
 */
export const MAX_BODY_BYTES = 16 * 1024;

export type ParsedPayload =
  | { ok: true; fields: ContactFields; honeypot: string }
  | { ok: false; reason: "not_an_object" | "unknown_field" | "wrong_type" };

/**
 * Turns an untrusted JSON body into typed fields, or rejects it. Every value
 * must be a string; a number, array, object or null is a malformed request
 * rather than something to coerce quietly.
 */
export function parsePayload(body: unknown): ParsedPayload {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "not_an_object" };
  }

  const record = body as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) return { ok: false, reason: "unknown_field" };
  }

  for (const key of ALLOWED_KEYS) {
    if (key in record && typeof record[key] !== "string") {
      return { ok: false, reason: "wrong_type" };
    }
  }

  return {
    ok: true,
    fields: {
      name: ((record.name as string) ?? "").trim(),
      email: ((record.email as string) ?? "").trim(),
      message: ((record.message as string) ?? "").trim(),
    },
    honeypot: ((record.reference as string) ?? "").trim(),
  };
}
