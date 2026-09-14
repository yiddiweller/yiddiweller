# Architecture

How yiddiweller.com is organised, and the rules future phases follow.
Database specifics are in [`database.md`](./database.md).

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
| Status | **Built** | Not built | Not built |

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
- A third surface appears, such as a native app or a separate marketing site.
- The production build exceeds a few minutes.
- More than about three engineers work in the repository at once.

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

---

## Current layout

```
app/
  (public routes)            Home, Work, Work/[slug], Contact, 404
  api/contact/route.ts       The only API route. Node runtime.
  globals.css                Design tokens
components/                  Presentation only
lib/
  contact.ts                 Validation, shared by the form and the server
  db/                        Server-only data layer
    index.ts                 Lazy connection. The single entry point.
    schema.ts                Tables and conventions
    inquiries.ts             Domain module: everything done with inquiries
    id.ts                    UUIDv7
  emails.ts  site.ts  social.ts  env.ts  log.ts
drizzle/                     Committed migrations
scripts/                     migrate.mjs, check-env.mjs
tests/                       node:test, no framework
```

**Route handlers never build queries.** They call a domain module in `lib/db/`.
That keeps the shape of a table changeable from one place, and it is the pattern
every future domain follows: one module per domain, not one giant data-access
layer and not queries scattered through routes.

When Studio arrives, public routes move into an `app/(public)/` group and Studio
into `app/(studio)/`. No public route moves before then — restructuring for
theoretical cleanliness costs review time and gains nothing.

---

## The Studio subdomain

Studio will be served from `studio.yiddiweller.com` by the **same application**,
distinguished by host. `dashboard.yiddiweller.com` should redirect there rather
than serve anything of its own.

A subdomain rather than a path, for a reason better than aesthetics: it gives
Studio its own cookie scope, so an internal session cookie is never transmitted
with public page requests. That is a real security boundary.

Nothing in Phase 1 blocks this. It needs, in a later phase, a Railway service or
domain pointed at the same application, host-based routing in middleware, and an
auth boundary on the Studio route group. No DNS was changed in Phase 1 and no
Studio route exists.

---

## Reserved slugs

Client workrooms will live at `yiddiweller.com/<slug>`, for example
`yiddiweller.com/avio`. A root-level dynamic segment resolves *after* static
routes in Next.js, so `/contact` already wins over `/[slug]`. Relying on that
implicitly is fragile: a client slug matching a future route would silently
shadow it, and the collision would appear only when that route was added.

**Rule: a client slug is validated against a reserved list at creation time, and
the workroom route checks the list before lookup.** Two independent guards, so a
slug created by some future admin path cannot bypass the routing one.

Reserved at minimum:

```
api  work  contact  studio  admin  dashboard  login  logout  auth
account  settings  privacy  terms  sitemap.xml  robots.txt
manifest.webmanifest  favicon.ico  opengraph-image.png  _next  .well-known
```

Plus a buffer of plausible future pages: `about`, `services`, `journal`,
`press`, `careers`, `clients`, `projects`, `blog`, `search`.

The list becomes a database table when workrooms are built, not a constant, so
it can grow without a deploy. No table is needed yet.

**The alternative, honestly.** A prefix such as `/c/avio` removes the collision
risk entirely at the cost of a less elegant URL. The bare slug was chosen
deliberately; it buys a permanent discipline. A workroom link sent to a client
lives in their inbox forever, so this is expensive to change later.

---

## Activity versus audit

Two separate concerns that must not be merged into one table. Neither is built
yet; the convention exists so later phases do not invent incompatible ones.

| | Business activity | Security / audit log |
| --- | --- | --- |
| Purpose | Human-readable timeline | Accountability record |
| Shown to | Team, and sometimes the client | Nobody, in normal use |
| Mutable | Can be filtered, softened, hidden | Never edited or deleted |
| Examples | `presentation.viewed`, `approval.submitted`, `invoice.opened` | `auth.login_failed`, `permission.granted`, `workroom.pin_failed` |
| Retention | Product decision | Compliance decision |

Conflating them produces either a feed full of security noise or an audit trail
that can be edited. Event names are `noun.verb_past_tense`.

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
