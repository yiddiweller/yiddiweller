"use client";

import { useActionState, useId, useRef, useState } from "react";

import { PrecisionControl } from "@/components/workrooms/ReviewStage";
import { anchorAfterSubjectChange, capturesTime, type TimeCandidate } from "@/lib/workrooms/time-capture";
import { BODY_MAX } from "@/lib/workrooms/review-input";
import { type ActionResult } from "@/lib/studio-result";
import styles from "@/components/workrooms/ReviewThread.module.css";

/**
 * One option in the *what is this about* control. A position, never an id.
 * `capture` marks a block that takes a precise time — read from the frozen
 * Revision the page is rendering, never from anything the browser inspects.
 */
export type ReviewSubject = { value: string; label: string; capture?: "time" | "point" };

/**
 * Somewhere to write: a new point, a reply, or a correction to your own words.
 *
 * **One form for all three.** They differ by what they are called, what they
 * are prefilled with and which action they call — never by shape — so the
 * counter, the empty-field refusal, the in-flight lock and the keyboard
 * behaviour are written once. A reply box and a correction box that drifted
 * apart would drift in exactly the way a client would notice.
 *
 * `trigger` collapses it behind a quiet button. A thread with a textarea under
 * every note is a form, not a conversation; the one composer that is open by
 * default is the one for saying something new, and only when there is nothing
 * else on the page inviting you to.
 *
 * The field is bounded by the same `BODY_MAX` the server enforces, so the
 * browser stops at the limit instead of the round trip doing it — but the
 * server still enforces it, because `maxLength` is a courtesy to a person and
 * nothing at all to a script.
 */
export default function ReviewComposer({
  action,
  fields,
  label,
  submitLabel,
  busyLabel,
  trigger,
  placeholder,
  defaultBody,
  subjects,
  hint,
}: {
  action: (previous: ActionResult | null, form: FormData) => Promise<ActionResult>;
  fields: Record<string, string | number>;
  label: string;
  submitLabel: string;
  busyLabel: string;
  /** Present when the form is collapsed until asked for. */
  trigger?: string;
  placeholder?: string;
  defaultBody?: string;
  /** The parts of the work a point may be about. Client composer only. */
  subjects?: ReviewSubject[];
  hint?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(trigger === undefined);
  const area = useRef<HTMLTextAreaElement>(null);
  // What the unsent point is about, and — for a recording or a video — the precise time
  // chosen in it. Both belong to this draft only; sending or switching the
  // subject is the end of them.
  const [subject, setSubject] = useState("");
  const [anchor, setAnchor] = useState<TimeCandidate | null>(null);
  const about = subjects?.find((candidate) => candidate.value === subject);
  const [result, submit, pending] = useActionState<ActionResult | null, FormData>(
    async (previous, form) => {
      const outcome = await action(previous, form);
      if (outcome.ok) {
        setSubject("");
        setAnchor(null);
      }
      // Collapses only on success, and only when it had somewhere to collapse
      // to. A refusal keeps the words that were refused: retyping a paragraph
      // because the server said no is the cost of a form that tidies itself.
      if (outcome.ok && trigger !== undefined) setOpen(false);
      return outcome;
    },
    null,
  );

  if (!open) {
    return (
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.buttonQuiet}
          aria-expanded={false}
          aria-controls={`${id}-form`}
          onClick={() => {
            setOpen(true);
            // The next paint has the field; focusing before it exists is a
            // no-op that reads as the button having done nothing.
            requestAnimationFrame(() => area.current?.focus());
          }}
        >
          {trigger}
        </button>
        {result?.ok ? (
          <span className={styles.status} role="status">
            {result.message}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <form
      id={`${id}-form`}
      action={submit}
      className={`${styles.composer} ${trigger === undefined ? "" : `${styles.composerOpen} ${styles.rise}`}`}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {subjects && subjects.length > 0 ? (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-item`}>
            About
          </label>
          <select
            id={`${id}-item`}
            className={styles.select}
            name="item"
            defaultValue=""
            onChange={(event) => {
              const next = event.target.value;
              // A time belongs to one file; it never follows the comment
              // to another block, or to the version as a whole.
              setAnchor((current) => anchorAfterSubjectChange(subject, next, current));
              setSubject(next);
            }}
          >
            <option value="">This version as a whole</option>
            {subjects.map((subject) => (
              <option key={subject.value} value={subject.value}>
                {subject.label}
              </option>
            ))}
          </select>
          {/* Keyed by the block, so moving to another file ends any
              capture still open on the last one. */}
          {about && capturesTime(about) ? (
            <PrecisionControl
              key={about.value}
              subject={Number(about.value)}
              name={about.label}
              draft={anchor}
              onDraft={setAnchor}
              composer={area}
            />
          ) : null}
        </div>
      ) : null}

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-body`}>
          {label}
        </label>
        <textarea
          id={`${id}-body`}
          ref={area}
          className={styles.textarea}
          name="body"
          rows={4}
          maxLength={BODY_MAX}
          placeholder={placeholder}
          defaultValue={defaultBody}
          required
        />
        {hint ? <p className={styles.hint}>{hint}</p> : null}
      </div>

      {/* Reserved whether or not there is anything to say, so a refusal does
          not move the button out from under the thumb pressing it. */}
      <p
        className={`${styles.status} ${result && !result.ok ? styles.statusError : ""}`}
        role="status"
        aria-live="polite"
      >
        {result && !result.ok ? result.message : ""}
      </p>

      <div className={styles.controls}>
        <button type="submit" className={styles.button} disabled={pending}>
          {pending ? busyLabel : submitLabel}
        </button>
        {trigger === undefined ? null : (
          <button
            type="button"
            className={styles.buttonQuiet}
            disabled={pending}
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
