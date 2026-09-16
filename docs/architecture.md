# Architecture

How yiddiweller.com is organised, and the rules future phases follow.
The locked product and domain decisions are in [`blueprint.md`](./blueprint.md),
which this document implements. Database specifics are in
[`database.md`](./database.md), and Studio — routing, authentication, roles and
invitations — is in [`studio.md`](./studio.md).

---

## One application, three experiences

The platform will present three experiences with deliberately different
information density:

| | Public | Client | Studio |
| --- | --- | --- | --- |
| Address | `yiddiweller.com` | `yiddiweller.com/<slug>` | `studio.yiddiweller.com` |
| Audience | Anyone | One client | Yiddi Weller team |
| Access | Open | PIN or client account | Team only |
| Density | Extremely minimal | Minimal and functional | Powerful and efficient |
| Indexing | Indexed | Never | Never |
| Status | **Built** | Not built | **Built and live** — Build 002 |

**They live in one Next.js application, not a monorepo.** That was the Phase 0
recommendation and it was accepted. The reasoning, restated so it can be
challenged later rather than assumed: the application is roughly two thousand
lines across ten routes. Splitting it would add workspace tooling, a build
orchestrator, shared package boundaries and duplicated configuration before
Studio has a single screen. Next.js route groups already give each experience
its own layout, visual system, metadata defaults and access boundary inside one
deployable.

**Split into separate applications when any of these becomes true**, and not
before:

- Studio and the public site need different deploy cadences or uptime guarantees.
- Their scaling patterns diverge materially.
- Security isolation between the public surface and internal data is required.
- A third surface appears, such as a native app or a separate marketing site.
- The production build exceeds a few minutes.
- Team ownership boundaries form, or more than about three engineers work in the
  repository at once.

The decision is cheap to reverse **provided shared logic stays in modules with
clean boundaries**. `lib/db`, and later `lib/auth`, `lib/permissions` and
`lib/domain`, must never import from a route. Keep that true and the eventual
extraction is a file move.

### What is shared, and what is not

Shared: the database client and schema, session and authorisation logic, domain
transitions such as lead becoming client, validation, and the activity event
vocabulary.

**Not shared: components.** Public and Studio share design *tokens* only. A
public hero and a Studio data table have nothing structural in common, and
forcing shared components produces a compromised middle that serves neither.
Studio's own system is in [`studio-design.md`](./studio-design.md); the two are
deliberately separate, which is why the public chrome moved out of the root
layout when Studio arrived.

---

## Current layout

```
middleware.ts                Host routing only. Edge runtime, no database.
app/
  layout.tsx                 The document: html, body, tokens, icons. No chrome.
  (public)/                  Home, Work, Work/[slug], Contact — header, footer, cursor
  studio/                    Sign in, Accept invitation, and the signed-in (app) shell
  workrooms/                 The client world: sign in, accept an invitation, and
                             the signed-in (room) shell. Its own chrome, neither
                             the public site's nor Studio's.
  not-found.tsx              The 404 for an unmatched URL. Brings its own frame.
  api/contact/route.ts       Node runtime.
  api/auth/[...all]/route.ts Better Auth's endpoints. Node runtime.
  globals.css                Design tokens
components/                  Presentation only. components/studio/ is separate.
lib/
  contact.ts                 Validation, shared by the form and the server
  business.ts                The business core's vocabulary, shared the same way
  hosts.ts                   Which world a request belongs to
  studio-nav.ts              Studio's navigation, as data
  studio-format.ts           How Studio writes dates, times and date fields
  studio-result.ts           Outcome → the sentence a form shows
  workrooms/
    id.ts                    The opaque identifier a Workroom is reached by
    view.ts                  The only shape that reaches a client surface
  auth/
    access.ts                The access rule, with no framework around it
    guard.ts                 currentStaff / requireStaff / requireOwner
    config.ts  client.ts     Better Auth, server and browser
  client-auth/               The second Better Auth instance. Clients.
    config.ts                Its own tables, cookie, secret and base path
    guard.ts                 currentViewer / requireViewer
    invitation-plugin.ts     Accepting, as an endpoint, using the library's
                             own session primitives
    client.ts                The browser half
  db/                        Server-only data layer
    index.ts                 Lazy connection, and the transaction type
    schema.ts                Tables and conventions
    outcome.ts               How an operation reports a refusal
    audit.ts                 Append-only record, written inside the caller's transaction
    inquiries.ts             Domain module: everything done with inquiries
    staff.ts                 Domain module: staff and invitations
    clients.ts  contacts.ts  leads.ts  projects.ts   The business core
    workrooms.ts             Client access: workrooms, membership, invitations
    activity.ts              The client-facing timeline. Not the audit log.
    search.ts                One search across all four
    id.ts                    UUIDv7
  emails.ts  site.ts  social.ts  env.ts  log.ts
drizzle/                     Committed migrations
scripts/                     migrate.mjs, check-env.mjs, bootstrap-owner.mjs
tests/                       node:test, no framework
```

**Route handlers never build queries.** They call a domain module in `lib/db/`.
That keeps the shape of a table changeable from one place, and it is the pattern
every future domain follows: one module per domain, not one giant data-access
layer and not queries scattered through routes.

**Neither do server actions.** A Studio action reads the form, re-checks the
caller, calls one domain function and turns its `Outcome` into a sentence. Every
rule that matters — what may be archived, what happens in one transaction, what
is refused — is in the domain module, where a test can reach it without a
browser.

That move happened in Build 002, and not for tidiness: the root layout carried
the public header, footer and cursor, so the Studio shell rendered inside them
with its `<main>` nested in the public one. Chrome belongs to a world, so each
world now owns its own layout and the root layout is the document alone. No URL
changed — a route group is invisible in the path.

Studio is at `app/studio/` rather than `app/(studio)/` because the path
`/studio` is real on the beta and local hosts, and is what the Studio host
rewrites to. See [`studio.md`](./studio.md).

---

## The Studio subdomain

Studio will be served from `studio.yiddiweller.com` by the **same application**,
distinguished by host.

A subdomain rather than a path, for a reason better than aesthetics: it gives
Studio its own cookie scope, so an internal session cookie is never transmitted
with public page requests. That is a real security boundary.

`studio.` is the **only** product subdomain. The blueprint forbids `admin.`,
`dashboard.`, `app.`, `portal.`, `client.`, `clients.`, `pay.`, `files.`,
`auth.`, `login.` and `api.` without an explicit revision.

Build 002 implemented the routing and the auth boundary. `lib/hosts.ts`
classifies every request as `studio`, `public` or `internal`, and `middleware.ts`
acts on it: the Studio host serves Studio at its root, the public host answers
404 for `/studio/*`, and the beta preview and localhost serve it at `/studio`.

That was completed on 2026-09-15: `studio.yiddiweller.com` is a custom domain on
the production service, `STUDIO_HOST` is set there, and `APP_URL` is the Studio
origin — which is also Better Auth's `baseURL`, so the host-scoped session
cookie lands where the sign-in link does. It took no code change. Recorded in
[`studio.md`](./studio.md).

---

## Reserved slugs — superseded, and kept as the reasoning

**This section described a design that was not built. It is kept because the
argument it records is the argument that chose the design we did build.**

The plan was: client workrooms at `yiddiweller.com/<slug>`, for example
`yiddiweller.com/avio`, defended by a reserved list validated at creation time
and re-checked by the workroom route — two independent guards, so a slug created
by some future admin path could not bypass the routing one. The reserved list
was to become a database table "when workrooms are built". The second row of it
held the client-facing namespaces the blueprint reserved at the root:
`/pay/...`, `/invoice/...`, `/files/...`, `/approve/...`.

The section closed with an alternative:

> **The alternative, honestly.** A prefix such as `/c/avio` removes the
> collision risk entirely at the cost of a less elegant URL.

**Build 004 took the alternative.** Workrooms live at
`/workrooms/{26-char opaque id}`. Build 005 makes that the locked design and
extends it: delivery routes nest beneath the Workroom that authorizes them, and
there are no root `/files/...` or `/approve/...` routes. The reasoning, and the
three technical arguments that had accumulated behind the prefix by then, are in
[`blueprint.md`](./blueprint.md) and [`delivery.md`](./delivery.md).

**Therefore:**

- **No reserved-slug table exists and none is needed.** It protected a bare-slug
  address. There is no bare-slug address.
- **No root namespace is reserved for a client-facing route.** A future one —
  `/pay`, `/invoice` — is decided when Build 006 plans it, with the presumption
  that it is prefixed too.
- **The collision risk this section existed to manage is gone**, not managed.
  That is the difference worth noticing: the guard was not removed, the thing it
  guarded was.

---

## Activity versus audit

Two separate concerns that are two tables and always will be. **Both are built:
audit in Build 003, activity in Build 004** — see [`audit.md`](./audit.md) and
[`activity.md`](./activity.md). Communications, the third thing, is still
unbuilt, and this table is why it will not collide with either.

| | Business activity | Security / audit log |
| --- | --- | --- |
| Purpose | Human-readable timeline | Accountability record |
| Shown to | Team, and sometimes the client | Nobody, in normal use |
| Mutable | Can be filtered, softened, hidden | Never edited or deleted |
| Examples | `presentation.published`, `approval.decided`, `review.received` | `auth.login_failed`, `approval.granted`, `client_identity.disabled` |
| Retention | Product decision | Compliance decision |

Conflating them produces either a feed full of security noise or an audit trail
that can be edited. Event names are `noun.verb_past_tense`.

**The examples above were replaced with the real vocabulary** once Builds 004
and 005 defined one. They previously read `presentation.viewed`,
`approval.submitted`, `invoice.opened` and `workroom.pin_failed` — illustrations
written before either table existed. Two of them are worth a note rather than a
silent swap:

- **`presentation.viewed` is deliberately not built**, in either table. Activity
  is the *client's* timeline, so a row recording that they opened something
  shows them a log of their own reading — surveillance, in a product whose
  principle is *personal everywhere*. See [`delivery.md`](./delivery.md).
- **`workroom.pin_failed` describes a mechanism that never shipped.** Client
  access is an authenticated identity, not a PIN. The *attribution* rule below
  survives it intact and is enforced by a CHECK constraint.

The live vocabularies are in [`activity.md`](./activity.md) and
[`audit.md`](./audit.md), and neither page may invent a value outside them.

**Attribution rule.** Every event carries an `actor_type`, one of `team_user`,
`client_user` or `anonymous_session`, with a nullable actor id. A shared PIN
session proves that *a workroom* was opened; it does not prove *which person*
opened it. The data model must make it impossible for the interface to claim
more than is known, rather than merely discouraging it.

---

## The contact flow

The only path in the application that writes data.

```
submit → rate limit → size check → parse (unknown fields rejected)
       → honeypot → validate → persist → notify → receipt
```

Both the form and the server import `lib/contact.ts`, so client and server
validation cannot drift. The server re-validates regardless; browser validation
is never trusted.

**Failure behaviour.** An inquiry is safe if it was stored *or* delivered:

| Stored | Emailed | Response | Why |
| --- | --- | --- | --- |
| yes | yes | `200` | Normal. |
| yes | no | `200` | The message is kept. The email failure is logged at error level. |
| no | yes | `200` | It reached the inbox. Logged at error level as `contact.delivered_unrecorded`, because it is missing from the database. |
| no | no | `502` | Genuinely lost, and the visitor is told so. |

Telling someone their message failed when it did arrive makes them send it again
or give up, so success is reported whenever the message actually survived. The
loud log is what surfaces the half-failure.

An identical message resubmitted within ten minutes resolves to the existing
row and does not send a second notification. Uniqueness is enforced by a unique
index on a digest, not by reading first, so two simultaneous requests cannot
both decide they are the original.

**Client IP resolution.** The rate limiter keys on the **rightmost**
`X-Forwarded-For` entry — the one appended by the proxy directly in front of the
app. Entries to its left are supplied by the caller and can be invented, so the
previous leftmost reading could be bypassed by rotating one header. If Railway
ever runs more than one proxy hop this needs to skip that many from the right.
The symptom of getting it wrong is the limiter treating all visitors as one
client, because the resolved value has become an internal address.

---

## Logging

One-line JSON to stdout, so Railway's log view stays greppable by `event`.

**Never logged:** secrets, connection strings, message bodies, raw email
addresses, honeypot contents. Addresses are reduced to `***@domain`.

One trap worth knowing about, found while testing Phase 1: a failed Drizzle
query throws an `Error` whose `message` contains the SQL *and every bound
parameter*. Logging `error.message` directly would write the submitter's name,
address and message into the logs on any database fault. `describeError` in
`lib/log.ts` reports the error name, SQLSTATE code and constraint name instead,
and there is a test asserting a visitor's words never reach a log line.
