"use client";

import { useId, useRef, useState } from "react";

import { LIMITS, validate, type ContactFields, type FieldErrors } from "@/lib/contact";

import styles from "./ContactForm.module.css";

type Status = "idle" | "sending" | "sent" | "error";

const EMPTY: ContactFields = { name: "", email: "", message: "" };

export default function ContactForm() {
  const [fields, setFields] = useState<ContactFields>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const honeypot = useRef<HTMLInputElement>(null);
  const id = useId();

  const update = (key: keyof ContactFields) => (value: string) => {
    setFields((current) => ({ ...current, [key]: value }));
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }));
  };

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "sending") return;

    const found = validate(fields);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      setStatus("error");
      setMessage("Please check the highlighted fields.");
      return;
    }

    setStatus("sending");
    setErrors({});
    setMessage("");

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, company: honeypot.current?.value ?? "" }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setErrors(data.fields ?? {});
        setStatus("error");
        setMessage(data.error ?? "The message could not be sent.");
        return;
      }

      setFields(EMPTY);
      setStatus("sent");
      setMessage("Message sent.");
    } catch {
      setStatus("error");
      setMessage("The message could not be sent. Please try again.");
    }
  }

  const fieldProps = (key: keyof ContactFields) => ({
    id: `${id}-${key}`,
    name: key,
    value: fields[key],
    maxLength: LIMITS[key],
    "aria-invalid": errors[key] ? (true as const) : undefined,
    "aria-describedby": errors[key] ? `${id}-${key}-error` : undefined,
  });

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-name`}>
          Name
        </label>
        <input
          {...fieldProps("name")}
          type="text"
          autoComplete="name"
          className={styles.input}
          onChange={(event) => update("name")(event.target.value)}
        />
        {errors.name ? (
          <p className={styles.error} id={`${id}-name-error`}>
            {errors.name}
          </p>
        ) : null}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-email`}>
          Email
        </label>
        <input
          {...fieldProps("email")}
          type="email"
          inputMode="email"
          autoComplete="email"
          className={styles.input}
          onChange={(event) => update("email")(event.target.value)}
        />
        {errors.email ? (
          <p className={styles.error} id={`${id}-email-error`}>
            {errors.email}
          </p>
        ) : null}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-message`}>
          Message
        </label>
        <textarea
          {...fieldProps("message")}
          rows={4}
          className={`${styles.input} ${styles.textarea}`}
          onChange={(event) => update("message")(event.target.value)}
        />
        {errors.message ? (
          <p className={styles.error} id={`${id}-message-error`}>
            {errors.message}
          </p>
        ) : null}
      </div>

      {/* Honeypot — off-screen, never focusable, ignored by assistive tech. */}
      <div className={styles.honeypot} aria-hidden="true">
        <label htmlFor={`${id}-company`}>Company</label>
        <input
          ref={honeypot}
          id={`${id}-company`}
          name="company"
          type="text"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      <div className={styles.actions}>
        <button type="submit" className={styles.submit} disabled={status === "sending"}>
          {status === "sending" ? "Sending" : "Send message"}
          <span aria-hidden="true" className={styles.arrow}>
            →
          </span>
        </button>

        <p
          className={styles.status}
          data-tone={status === "error" ? "error" : "ok"}
          role="status"
          aria-live="polite"
        >
          {message}
        </p>
      </div>
    </form>
  );
}
