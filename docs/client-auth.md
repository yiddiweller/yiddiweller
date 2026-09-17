# Client authentication

How a client gets into a Workroom, and why none of it touches Studio.

Introduced in Build 004. The Workroom model is in
[`workrooms.md`](./workrooms.md); staff authentication is unchanged and remains
in [`studio.md`](./studio.md).

---

## The rule everything else follows

# A client is never a staff user.

Not a row in `user`. Not an Owner, not a Member. A client session can never
satisfy `requireStaff` or `requireOwner`, and a Studio session can never open a
Workroom. They are two authentication systems that happen to run in one
application, and the only thing they share is the database connection.

That is enforced structurally rather than by care: they are separate Better Auth
instances, with separate tables, separate cookies, separate secrets and separate
API base paths. Neither one can read the other's session, because neither one
knows the other's cookie name or can verify its signature.

---

## Two instances, one library

`lib/auth/config.ts` — **staff**, unchanged since Build 002.
`lib/client-auth/config.ts` — **clients**, new.

| | Staff | Client |
| --- | --- | --- |
| Tables | `user`, `session`, `account`, `verification` | `client_identities`, `client_sessions`, `client_credentials`, `client_verifications` |
| Cookie prefix | `yw_studio` | `yw_client` |
| Secret | `BETTER_AUTH_SECRET` | `CLIENT_AUTH_SECRET` |
| Base URL | `APP_URL` (the Studio origin in production) | `CLIENT_AUTH_URL` (the public origin) |
| API path | `/api/auth` | `/api/client-auth` |
| Rate-limit table | `auth_rate_limits` | `client_rate_limits` |
| Sign-up | Disabled | Disabled |
| Sign-in | Magic link | Magic link |

Better Auth supports this directly: `modelName` renames every core model, and
the Drizzle adapter resolves a model against the schema export of that name. No
fork, no second library, and no hand-written session cryptography.

**Two instances need two rate-limit tables.** Both expose
`/sign-in/magic-link`, and Better Auth keys its limiter by path and address —
one shared table would let a staff sign-in and a client sign-in from the same
office consume each other's allowance.

`client_credentials` exists because it is Better Auth's `account` model, part of
the core schema the adapter may resolve. With magic-link-only sign-in nothing
writes to it, exactly as the staff `account` table has stayed empty since
Build 002. It is framework infrastructure, not a speculative feature.

---

## Identity is attached to a Contact

A **client identity** is the login. A **Contact** is the person. One identity
belongs to exactly one Contact — `client_identities.contact_id` is `UNIQUE` —
and most Contacts have no identity at all, because most people never need to
sign in to anything.

There is no second name, no second company, no shadow person inside the auth
system. Display names come from the canonical Contact.

---

## The access email is not the contact email

This is the part worth reading twice.

`contacts.email` is a business field. Staff edit it when somebody changes job or
corrects a typo. `client_identities.email` is a **verified authentication
credential** — the mailbox that can request a sign-in link and receive it.

**Editing a Contact's email never moves their access.** If it did, an ordinary
CRM correction would hand somebody's Workroom to a different mailbox, and the
audit trail would show a contact edit rather than a change of access. That is a
credential transfer disguised as a typo fix.

So:

- The identity's email is set once, at invitation acceptance, from the address
  the invitation was actually sent to.
- Nothing afterwards copies `contacts.email` into it.
- Where an identity already exists, a new invitation for that Contact is
  addressed to the identity's **verified** email, not to the contact record's.
  Studio shows which address it will use, and says why.
- Build 004 has no flow for changing a verified access email. Moving access to a
  new mailbox is: revoke the membership, disable the identity if appropriate,
  and invite again. Deliberate, visible, audited.

A non-editable correct system beats an editable dangerous one.

---

## No open sign-up

There is no "create account". Access begins with an invitation from staff, and
nothing else creates a client identity — `disableSignUp` is set on the magic
link plugin, and the identity row is written by the invitation acceptance
transaction rather than by a sign-in.

### The sign-in endpoint is not a mail sender

Build 002 learned this the hard way: `disableSignUp` stops Better Auth
*creating* a user on verification, but it does not stop it *sending* mail to
whatever address was typed. Left alone, the sign-in form becomes a way to send
Yiddi Weller branded email to anybody in the world, and its response tells the
sender whether that address has access.

So the client instance checks before sending, in `sendMagicLink`, and returns
quietly when the answer is no. A link is sent only to an address that:

1. belongs to an **active** client identity, and
2. holds at least one **active** membership in a **published, unarchived**
   Workroom.

Everything else — unknown address, disabled identity, revoked access, a
Workroom that has been unpublished — produces the same neutral page and no
email at all. There is nothing in the response to tell them apart.

Nothing in the response, and nothing in how long it takes. A sign-in that
waited for the mail provider answered in 28–76ms for a known address against
~15ms for an unknown one, every run — the same question asked with a
stopwatch. Delivery no longer happens inside the request (`lib/auth-delivery.ts`
says why, and why that is safe here), and the two now sit on top of each other:
medians of 17.6ms and 16.0ms over fifteen samples each, both ranging 14–20ms.

Nor in where it sends you afterwards. A `callbackURL` is honoured only if it
is a path under `/workrooms`; anything else — another origin, a
protocol-relative URL, a `javascript:` URL, `/studio/clients`,
`/workrooms/../studio` — becomes `/workrooms`. Better Auth refuses the
cross-origin cases by itself, but it cannot know that `/studio` on this origin
is a second product with a second identity system, so the rule is stated in
`lib/client-auth/redirect.ts`. Both halves of the flow carry a `callbackURL`
and both are sanitised: the sign-in `POST` in its body, the verification `GET`
in its query string. Sanitising only the body left
`/magic-link/verify?callbackURL=/studio/clients` still working.

---

## Sessions

Better Auth's own session handling, with these settings:

| | |
| --- | --- |
| Cookie | `yw_client.session_token`, `HttpOnly`, `SameSite=Lax`, `Secure` in production |
| Domain | **Host-scoped.** No `domain` attribute is set. |
| Life | 30 days, refreshed a day at a time |
| Storage | The `client_sessions` table. Nothing in `localStorage`. |
| Sign out | Deletes the session row and expires the cookie. |

**Host-scoped is the whole point.** A cookie set for `.yiddiweller.com` would be
sent to `studio.yiddiweller.com` on every request, putting a client credential
in front of staff software. Without a `domain`, the browser keeps it to the
exact host that issued it, and `studio.yiddiweller.com` never sees it.

It is scoped by host rather than by path, so a future `/pay` flow on the same
public origin can reuse the identity without a cookie migration. Scoping it to
`/workrooms` would have to be undone the first time anything else on the public
site needed to know who a client is.

**Public pages stay static.** The client cookie exists on the public origin, but
no public page reads it — the home page, Work and Contact never call the client
session, never import client auth, and are still prerendered. Authentication
that quietly makes a marketing site dynamic is a performance bug wearing a
security badge.

### Revocation

Two levers, and they are different on purpose:

- **Revoke a membership** — the person loses one Workroom, immediately, because
  access is read from the membership row on every request rather than trusted
  from the session. Their other Workrooms are untouched and they are not signed
  out.
- **Disable an identity** — `status = inactive`. No new session can be created,
  and every existing session stops working on its next request, everywhere.

Neither deletes anything. Access history is why the audit log exists.

---

## Invitation acceptance issues the session

Acceptance is a `POST` to an endpoint added to the client Better Auth instance
by a small first-party plugin, `workroomInvitation()` in
`lib/client-auth/invitation-plugin.ts`.

It runs inside Better Auth's endpoint context, so the session is created by
`internalAdapter.createSession` and the cookie is written by `setSessionCookie`
— the library's own primitives, the same ones its magic-link plugin uses.
**Nothing here signs, encrypts or hashes a session by hand.**

The business half of acceptance — claiming the invitation, creating or reusing
the identity, granting the membership, writing audit and activity — is one
PostgreSQL transaction in `lib/db/workrooms.ts`, and the session is issued only
after it commits.

---

## Rate limiting

Client auth uses Better Auth's **database-backed** limiter, `client_rate_limits`,
rather than the in-memory default. It survives a deploy and would survive a
second instance. Staff auth moves to the same strategy in its own table, which
closes the in-memory rate-limiting item that has been open since Build 002.

| Path | Window | Max |
| --- | --- | --- |
| `/sign-in/magic-link` | 5 minutes | 5 |
| `/magic-link/verify` | 5 minutes | 10 |
| `/workroom-invitation/accept` | 5 minutes | 10 |
| everything else | 1 minute | 30 |

Invitation creation and resend are Studio server actions behind staff
authorization, so they are limited by having to be signed in as staff.

---

## What is never logged

No token, no magic link, no session cookie, no OTP, no email body. Addresses go
through `redactEmail`, as everywhere else since Build 001.

Structured events: `client.login_requested`, `client.login_refused`,
`client.login_succeeded`, `client.logout`, `workroom.invite_created`,
`workroom.invite_resent`, `workroom.invite_revoked`, `workroom.invite_accepted`,
`workroom.access_revoked`, `workroom.published`, `workroom.unpublished`.

**Audit is not a page-view log.** A client opening a Workroom writes nothing to
`audit_events`; that would turn an accountability record into traffic. Audit
gets the events that change who can reach what: invitation created, resent,
revoked, accepted; membership granted and revoked; identity disabled and
re-enabled; Workroom published, unpublished, archived, restored.

---

## Environment

| Variable | Environment | Notes |
| --- | --- | --- |
| `CLIENT_AUTH_SECRET` | every environment that serves Workrooms | **Per environment.** Sharing one between beta and production would make a beta client session valid in production. Never a build argument. |
| `CLIENT_AUTH_URL` | every environment that serves Workrooms | The public origin clients reach — `https://yiddiweller.com` in production, the Railway beta hostname in beta. Invitation and sign-in links are built from it, so a wrong value sends a client a link into the other environment. Not a secret. |

`scripts/check-env.mjs` reports both.

---

## Security assumptions, written down

- **The Workroom URL is unguessable, not secret.** Every read behind it checks
  membership server-side. A forwarded link gets whoever opens it a sign-in page,
  not a Workroom.
- **Mail is the authentication factor.** There is no password and no second
  factor, so a compromised mailbox is a compromised Workroom — the same
  assumption Studio has carried since Build 002, now extended to people outside
  the company. This is why delivery, SPF and DKIM are a promotion gate rather
  than a nicety.
- **Nothing a client sends mutates a business record.** Clients read. The only
  writes a client request causes are their own session, their own membership at
  acceptance, and the activity row that records it.
- **Concealment over explanation.** A non-member gets the same answer for a
  Workroom that exists and one that never did.
- **Two Contacts cannot share one access email.** `contacts` does not make
  email unique — a shared inbox is a real thing, and so are duplicate rows —
  but `client_identities.email` is a credential and does, because the
  alternative is one mailbox holding two people's access. If that is ever
  wanted, it needs a decision about what an identity means, not a relaxed
  index.
- **A refusal about the client identity is made where somebody can act on it.**
  Two conditions stop an acceptance for reasons that have nothing to do with
  the invitation: the address already belongs to another Contact's identity,
  and this person's sign-in was switched off after the link was sent. Both are
  now checked in three places — by `inviteToWorkroom` before a link is created,
  by `inspectWorkroomInvitation` before the landing page promises entry, and by
  the acceptance itself, whose insert-conflict handling remains the last line
  against a race.

  **This is a correction, and the reason is worth keeping.** Manual beta
  acceptance found a fresh, in-date invitation whose landing page showed the
  right name and address above *Open my work room*, and whose button answered
  *that invitation cannot be used*. A Build 004 test Contact held the same
  human's address, so the acceptance was predetermined to fail — and only the
  acceptance knew. The studio had been allowed to create a dead link, the page
  had been allowed to promise it, and the client was told to *ask for a sign-in
  link*, which would have failed for the same reason.

  So the two causes also stopped sharing a word. `unavailable` now means only
  what it says — the Workroom is unpublished or archived — and `access_off` and
  `email_taken` are their own reasons, with their own copy. The client-facing
  wording for `email_taken` deliberately names no other record: it is ours to
  untangle, and whoever holds a dead link may not be the person it was sent to.
  The staff-facing refusal does name the Contact holding the address, because
  that is the only actionable fact in it.
