/**
 * Reports which required server variables a deployment is missing, by name.
 * Never prints a value. Run it against a service after configuring it, rather
 * than discovering the gap from a visitor's failed submission.
 */
const REQUIRED = [
  "DATABASE_URL",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "CONTACT_EMAIL",
  // Studio, from Build 002. Both are required in every environment that serves
  // it: without APP_URL a sign-in link has no origin to point at, and without
  // BETTER_AUTH_SECRET sessions cannot be signed.
  "APP_URL",
  "BETTER_AUTH_SECRET",
  // Client Workrooms, from Build 004. Required in every environment that
  // serves them: CLIENT_AUTH_URL is the public origin a client's invitation
  // and sign-in links point at, and it is not APP_URL — in production that is
  // the Studio origin. The secret is the client auth instance's own and is
  // never the staff one.
  "CLIENT_AUTH_URL",
  "CLIENT_AUTH_SECRET",
];

/**
 * Delivery storage, from Build 005. Reported as its own group rather than
 * folded into REQUIRED, because "absent" means two different things here:
 *
 *   an environment that serves Files without these is broken
 *   an environment that does not serve Files yet is simply not there yet
 *
 * Production is the second case until Build 005 is promoted. Collapsing both
 * into one exit code would either cry wolf on production or stay quiet on a
 * beta that cannot store a byte. Missing them breaks the Files routes and
 * nothing else: the public site, Contact, Studio sign-in, the business core
 * and the Workroom overview never read them.
 */
const STORAGE = [
  "BUCKET_ENDPOINT",
  "BUCKET_NAME",
  "BUCKET_REGION",
  "BUCKET_ACCESS_KEY_ID",
  "BUCKET_SECRET_ACCESS_KEY",
];

// Not required. Studio lives at /studio until its subdomain is connected, and
// the bootstrap variables are read once, by hand, and then removed.
const OPTIONAL = ["SITE_ENV", "STUDIO_HOST"];

const missing = REQUIRED.filter((key) => !process.env[key]?.trim());

for (const key of REQUIRED) {
  console.log(`${missing.includes(key) ? "MISSING " : "present "} ${key}`);
}

const storageMissing = STORAGE.filter((key) => !process.env[key]?.trim());

for (const key of STORAGE) {
  console.log(`${storageMissing.includes(key) ? "MISSING " : "present "} ${key} (delivery storage)`);
}

for (const key of OPTIONAL) {
  console.log(`${process.env[key]?.trim() ? "present " : "unset   "} ${key} (optional)`);
}

if (storageMissing.length > 0 && storageMissing.length < STORAGE.length) {
  // Partial configuration is always a mistake. Four of five is not "nearly
  // there", it is a bucket that cannot be reached with a clear reason.
  console.error(
    `\nDelivery storage is partly configured: ${storageMissing.join(", ")} absent. ` +
      "All five or none.",
  );
  process.exit(1);
}

if (storageMissing.length === STORAGE.length) {
  console.log("\nDelivery storage is not configured. Files routes will not work here.");
}

if (missing.length > 0) {
  console.error(`\n${missing.length} required variable(s) absent: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("\nAll required server configuration is present.");
