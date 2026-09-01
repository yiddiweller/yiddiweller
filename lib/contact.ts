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
