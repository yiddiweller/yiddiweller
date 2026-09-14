/**
 * One-line JSON server logs, so Railway's log view stays greppable by `event`.
 *
 * Deliberately narrow: the caller passes an event name and a small bag of
 * non-sensitive fields. Secrets, connection strings, email bodies and message
 * text must never be passed in — see `docs/database.md` for the rule and
 * `redactEmail` for the one identifier we do record.
 */
type Level = "info" | "warn" | "error";

type Fields = Record<string, string | number | boolean | null | undefined>;

function emit(level: Level, event: string, fields: Fields = {}): void {
  const line = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...fields,
  });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, fields?: Fields) => emit("error", event, fields),
};

/**
 * Keeps the domain for triage while dropping the local part, so an operational
 * log never becomes a store of contact details.
 */
export function redactEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "invalid" : `***@${email.slice(at + 1)}`;
}

/**
 * Summarises an error for a log line without repeating anything a visitor
 * typed.
 *
 * This is stricter than it looks for a specific reason: a failed Drizzle query
 * throws an Error whose `message` is the SQL followed by every bound
 * parameter, so the obvious `${name}: ${message}` would write the submitter's
 * name, address and message body into the logs on any database fault. Postgres
 * errors carry the useful part — a SQLSTATE code and the constraint that
 * rejected the row — as properties instead, so those are reported and the
 * message is used only when it cannot contain a query.
 */
export function describeError(cause: unknown): string {
  const parts: string[] = [];
  let current: unknown = cause;

  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    const error = current as Error & {
      code?: string;
      constraint_name?: string;
      cause?: unknown;
    };

    const bits = [error.name];
    if (error.code) bits.push(`code=${error.code}`);
    if (error.constraint_name) bits.push(`constraint=${error.constraint_name}`);
    if (!CARRIES_QUERY.test(error.message)) bits.push(error.message.slice(0, 200));

    parts.push(bits.join(" "));
    current = error.cause;
  }

  return parts.length > 0 ? parts.join(" <- ") : "unknown error";
}

/** Shapes of error message that are known to embed SQL or bound parameters. */
const CARRIES_QUERY = /failed query|params:|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b/i;
