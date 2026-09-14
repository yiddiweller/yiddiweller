/**
 * Reports which required server variables a deployment is missing, by name.
 * Never prints a value. Run it against a service after configuring it, rather
 * than discovering the gap from a visitor's failed submission.
 */
const REQUIRED = ["DATABASE_URL", "RESEND_API_KEY", "RESEND_FROM_EMAIL", "CONTACT_EMAIL"];

const missing = REQUIRED.filter((key) => !process.env[key]?.trim());

for (const key of REQUIRED) {
  console.log(`${missing.includes(key) ? "MISSING " : "present "} ${key}`);
}

if (missing.length > 0) {
  console.error(`\n${missing.length} required variable(s) absent: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("\nAll required server configuration is present.");
