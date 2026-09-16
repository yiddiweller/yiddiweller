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

// Not required. Studio lives at /studio until its subdomain is connected, and
// the bootstrap variables are read once, by hand, and then removed.
const OPTIONAL = ["SITE_ENV", "STUDIO_HOST"];

const missing = REQUIRED.filter((key) => !process.env[key]?.trim());

for (const key of REQUIRED) {
  console.log(`${missing.includes(key) ? "MISSING " : "present "} ${key}`);
}

for (const key of OPTIONAL) {
  console.log(`${process.env[key]?.trim() ? "present " : "unset   "} ${key} (optional)`);
}

if (missing.length > 0) {
  console.error(`\n${missing.length} required variable(s) absent: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("\nAll required server configuration is present.");
