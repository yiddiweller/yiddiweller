# Studio

The private team world. Introduced in Phase 2, released as **Build 002**, and
**live in production at `studio.yiddiweller.com` since 2026-09-15**.

Product decisions are in [`blueprint.md`](./blueprint.md) and the permanent
interface system is in [`studio-design.md`](./studio-design.md); this file
records how Studio is actually built. Where the two disagree the blueprint wins and the
question goes back to Yiddi Weller rather than being settled in code.

---

## What exists

| Surface | Path | Who |
| --- | --- | --- |
| Sign in | `/studio/login` | Anyone may ask. A link is only ever sent to active staff. |
| Accept an invitation | `/studio/join?token=…` | Whoever holds a valid token. |
| Home | `/studio` | Any active staff member. |
| Clients | `/studio/clients`, `/studio/clients/[id]` | All staff. Archive and restore: Owner only. |
| Contacts | `/studio/contacts`, `/studio/contacts/[id]` | All staff. Archive and restore: Owner only. |
| Leads | `/studio/leads`, `/studio/leads/[id]` | All staff. Archive and restore: Owner only. |
| Projects | `/studio/projects`, `/studio/projects/[id]` | All staff. Archive and restore: Owner only. |
| Workrooms | `/studio/workrooms`, `/studio/workrooms/[id]` | All staff. Archive and restore: Owner only. |
| Client preview | `/studio/workrooms/[id]/preview` | All staff. The client's view, rendered through the client's own projection. |
| Search | `/studio/search` | Any active staff member. |
| Team | `/studio/team` | Roster: all staff. Invitations and deactivation: Owner only. |
| Audit | `/studio/audit` | **Owner only.** A Member receives a genuine 404. |
| Settings | `/studio/settings` | Any active staff member. Their own account. |

Home answers one question — what needs attention — from conditions that are true
of rows rather than from flags anybody has to set: an inquiry with no lead
behind it, a follow-up whose time has passed, live work past its target date.
When there is nothing, the section is not rendered at all.

The business core arrived in Build 003 and its model is
[`business-core.md`](./business-core.md); the audit policy is
[`audit.md`](./audit.md). Nothing beyond it is built: no workrooms, no files, no
invoices, and none of them is sketched into the interface in advance.

**Every list is a URL.** Filters are plain `GET` forms and the archive toggles
are links, so a view of a list survives a reload, can be sent to somebody, and
works before any JavaScript arrives. Filtering, sorting and paging happen in
PostgreSQL; no page assumes the studio will only ever have twenty clients.

**The shell is a left rail on desktop and a drawer on small screens**, driven by
one navigation list in `lib/studio-nav.ts`, so the two presentations cannot
drift apart. The reasoning, and the page architecture every future module plugs
into, are in [`studio-design.md`](./studio-design.md).

---

## Where Studio lives

One Next.js application serves both worlds, told apart by `Host`. The rule is in
`lib/hosts.ts` and applied in `middleware.ts`, which does host routing and
nothing else — it runs on the Edge runtime and must never touch the database.

| Host | Classified | Studio |
| --- | --- | --- |
| `studio.yiddiweller.com` (once `STUDIO_HOST` is set) | `studio` | At the root. `/team` is rewritten to `/studio/team`. |
| `yiddiweller.com`, `www.`, anything else in production | `public` | `/studio/*` answers **404**, by rewrite. |
| The beta service (any hostname, with `SITE_ENV=preview`), `localhost` | `internal` | At `/studio`. |

Production has `STUDIO_HOST=studio.yiddiweller.com` set, so the first row is
live: Studio answers at the root of its own host, and `yiddiweller.com/studio`
answers 404. Beta has no `STUDIO_HOST` and reaches Studio at `/studio` on its
Railway hostname.

The public host answering 404 rather than redirecting is deliberate: a redirect
would confirm that internal software sits behind that domain.

**Authorization is not done in middleware.** Every Studio page, layout and
server action checks the session against Postgres on every request. Middleware
decides which world a request belongs to; it decides nothing about who someone
is.

On beta, Studio is reached at `/studio` on whatever hostname Railway gave that
service — today `yiddiweller-beta.up.railway.app`. **Nothing depends on that
name.** A request is classified as `internal` because `SITE_ENV=preview` is set
there, not because of its address, which is what lets beta keep a generated
hostname and change it without a code change. The corollary is worth knowing: if
`SITE_ENV` were ever unset on beta, that host would classify as `public` and
`/studio` would answer 404 there.

### Connecting the subdomain — done, and what it took

`studio.yiddiweller.com` was connected on 2026-09-15: a custom domain on the
production service, a CNAME at Namecheap, Railway's verification, and
`STUDIO_HOST` set. **No code change was needed.** Earlier notes said Better
Auth's `baseURL` would have to move to the Studio origin — it does, but it is
`appUrl()`, so setting `APP_URL=https://studio.yiddiweller.com` was the whole
of it.

That value matters more than it looks. The session cookie is host-scoped, so a
sign-in link issued for one host cannot establish a session on another;
`APP_URL` is what puts the link where the cookie can live. It is also where
invitation links come from, through `studioUrl()`. The public site never reads
it — its canonical URL is in `lib/site.ts`. **Do not "correct" production's
`APP_URL` to the public domain.**

---

## Authentication

**Better Auth 1.7.5, magic link only.** No password, no social provider, no
registration form.

Chosen over Auth.js because Auth.js still ships v4 as stable while the
App-Router-native v5 has been in beta for more than thirty pre-releases. Better
Auth is on a stable 1.x, declares Next 16 and React 19 in its peers, ships a
first-party Drizzle adapter, and keeps identity in our own PostgreSQL rather
than at a vendor. It was not hand-rolled: session handling, token expiry,
CSRF-safe cookies and rate limiting are exactly the things a studio should not
be inventing.

Configuration is in `lib/auth/config.ts`. The lines that matter:

- `disableSignUp: true` on the magic-link plugin. Without it, anyone who can
  reach the sign-in form creates themselves an account.
- `emailAndPassword: { enabled: false }`, `socialProviders: {}`. Neither is a
  way in.
- `cookiePrefix: "yw_studio"`, and **no cookie domain**, so a Studio session
  cookie is never sent with a request to the public site.
- `generateId: () => uuidv7()`, so Better Auth's own rows follow the same
  identifier convention as every other table.
- Rate limiting: 10 requests a minute generally, 5 per five minutes on
  `/sign-in/magic-link`, 10 per five minutes on `/magic-link/verify`.

### `disableSignUp` does not stop the email

Found while testing Build 002, and worth stating plainly because the option's
name suggests otherwise: `disableSignUp` refuses to *create a user* when a link
is verified. It does not stop the link being **sent**. Better Auth mails
whatever address is typed into the form and turns it away only on arrival.

Left alone, that makes the sign-in form an open sender of Yiddi Weller branded
mail, and makes the response distinguishable between an address with access and
one without. So `sendMagicLink` checks the address first and returns quietly
when it is not an active staff member. The caller sees the same response either
way, so the endpoint cannot be used to discover who works here.

### The access decision

`lib/auth/access.ts` holds the rule, apart from the framework so it can be
tested directly:

```
no email            → nobody
unknown address     → nobody
status ≠ active     → nobody
otherwise           → that staff member, with their current role
```

It reads the database rather than trusting the session payload, so a role or
status change takes effect on the person's very next request rather than
whenever their cookie happens to expire.

`lib/auth/guard.ts` wraps it for routes:

| Function | Behaviour |
| --- | --- |
| `currentStaff()` | The signed-in active member, or `null`. Never throws. |
| `requireStaff()` | Redirects to `/studio/login` if there is nobody. |
| `requireOwner()` | `notFound()` for a signed-in non-Owner. |

`requireOwner` answers not-found rather than forbidden so Studio does not
confirm to a Member that a given management surface exists.

### Where a guard has to be called

This was measured against a running build rather than assumed, and the results
are not what the file layout suggests:

| Guard position | Status | Protected data in the response |
| --- | --- | --- |
| In the page, before the read | **404** | No |
| In the page, with a `loading.tsx` above it | 200 | No |
| In a parent layout | 404 | **Yes — the page ran anyway** |
| In a parent layout, with a `loading.tsx` beside the page | 404 | **Yes** |

Two things follow, and both are rules rather than preferences:

1. **A parent layout does not gate its children.** Next renders a layout and
   its page concurrently, so a page that fetches protected data fetches and
   ships it while the layout is still deciding. An anonymous request to such a
   page was observed returning a redirect whose body contained the data.
   The guard must be called **inside the component that reads**, before it
   reads.
2. **No `loading.tsx` above a guarded page.** A Suspense boundary flushes the
   shell first, and after that the response status cannot be set — so a refusal
   arrives as 200 with the not-found page inside it. Studio has no loading
   boundary for this reason; where one is worth adding later, it goes below
   every guard, never above one.

Today every Studio page calls `requireStaff()` itself before touching data,
and the `(app)` layout calls it too as defence in depth and to produce the
redirect for an anonymous request.

**Team is deliberately not an Owner-only page.** Members see the roster;
management — inviting, revoking, removing access — is Owner-only and lives in
server actions, which each re-check the caller and answer not-found for a
Member. Concealment is the policy for those actions, not for the page.

### Metadata is a second render, and it is not guarded by the page

`generateMetadata` runs independently of the page component. A page whose guard
refuses the request still has its title produced, and that title travels in the
refusal: measured during Build 003 hardening, an inactive member's `307` to the
sign-in page carried `Northwind Trading — Studio` in its `<title>`, which tells
somebody with no access at all the name of a client.

So a `generateMetadata` that reads a record checks the caller too — with
`currentStaff`, not a guard, because refusing is not metadata's job. Without an
entitled viewer it returns the generic title:

```tsx
if (!isId(id) || !(await currentStaff())) return { title: "Client" };
```

All four Build 003 detail pages do this, and `tests/authorization.test.ts` holds
it there.

### The entrance has four states

All four are designed rather than left to the framework:

| State | What it is |
| --- | --- |
| The door | Address, one control, no marketing. |
| On its way | "Check your email" — the same message whether or not the address has access. |
| A link that did not work | Expired, already used, or invalid. The sign-in request passes `errorCallbackURL` so the reason survives the redirect; without it a failed link lands on `/studio`, bounces to the sign-in page and loses the explanation. |
| An account without access | A Better Auth session whose staff record is not active. |

The last one is a safety net rather than an everyday path: removing access
deletes that person's sessions, so they normally return to the plain sign-in
form. It exists because a session that outlives access would otherwise put
someone in a loop — sign in, bounce, sign in — with nothing on screen to explain
why. It was verified by changing a status without deleting the session.

---

## Dates and times

The database keeps `timestamptz` in UTC and that does not change. Display is a
separate concern and lives entirely at the edge:

```
server   →  "15 Sept, 14:08 UTC"   labelled, so it is never quietly wrong
browser  →  "15 Sept, 16:08"       the same instant, in the viewer's own zone
markup   →  <time dateTime="2026-09-15T14:08:08.942Z">
```

`components/studio/Moment.tsx` is the only place this happens, and every Studio
timestamp goes through it. It uses `useSyncExternalStore` with a server
snapshot and a client snapshot, which is how the two sides can differ without a
hydration mismatch — React takes the server's value for the HTML it hydrates,
then the client's, and re-renders the difference. Verified in four zones with
no console errors and no hydration warnings.

Three rules for later modules:

- **Never call `Intl.DateTimeFormat` in a Studio page.** The zone would default
  to the server's, which on Railway is UTC and wrong for the person reading.
  Use `Moment`.
- **Formatting lives in `lib/studio-format.ts`**, takes an explicit zone, and is
  locale-fixed to en-GB. The zone is the part that has to be personal; the
  format is not, because two people describing the same record should see the
  same shape.
- **A field that collects an instant needs the same treatment.**
  `components/studio/MomentInput.tsx` prefills a `datetime-local` with the wall
  clock in the viewer's zone, exactly the zone the server reads it back in.
  Prefilling it in UTC and parsing it as local is how a follow-up quietly moves
  by five hours the first time somebody edits it.

A `date` column is different, and simpler: `starts_on` and `target_on` name a
day, not an instant, so there is no zone to resolve and `formatDate` is safe on
the server. `<Moment>` is for instants only.

If scripting never runs, the labelled UTC text stays on screen. That is the one
case the browser cannot fix, and it is true as it stands.

---

## Roles

Two, and only two, in `lib/db/schema.ts`:

| Role | Can |
| --- | --- |
| `owner` | Everything, including inviting, revoking, deactivating and reactivating staff. |
| `member` | Sign in, see Home, see the team roster, manage their own account. |

A third role should not be invented until a real person needs one. Adding one is
a `CHECK` constraint change and a migration, which is exactly why statuses and
roles are `text` with a check rather than a Postgres `ENUM`.

`status` is separate from role: `active` or `inactive`. Deactivating revokes
access without erasing the person — historical references stay intact — and
deletes their live sessions so it takes effect immediately.

An Owner cannot deactivate themselves. That is not politeness; it is what stops
Studio becoming unreachable.

**Production currently has exactly one Owner**, which is the obvious single
point of failure: the bootstrap script refuses to run while an active Owner
exists, so if that mailbox became unreachable there is no supported way back in
short of editing the database by hand. Inviting a second Owner is the cheap fix
and should happen before Studio holds client work.

---

## Invitations

There is no registration. A user row is created by exactly one code path,
`acceptInvitation` in `lib/db/staff.ts`, plus the one-time bootstrap below.

```
Owner invites  →  32 random bytes, stored as a SHA-256 digest
                  emailed once as a link, never stored in the clear
person clicks  →  the token is checked, they choose the name Studio knows them by
                  the invitation is consumed in the same transaction as the user row
```

- **Single use.** Accepting claims the row conditionally, inside a transaction
  with the insert. Two simultaneous submissions of the same link produce exactly
  one staff member; the second is told the invitation has already been used.
- **Seven day expiry.** After that the link is refused and a new one must be
  issued.
- **One open invitation per address**, enforced by a partial unique index rather
  than by reading first, so two concurrent invites cannot both succeed.
- **Revocable.** A revoked token reports `invalid` rather than a reason of its
  own: whoever holds a withdrawn link learns only that it does not work.
- **Unrecoverable.** The token is never stored, so a lost invitation is revoked
  and reissued, not looked up.

The acceptance page reads the token only to decide what to show. Redeeming it
happens in the server action, which repeats every check, because the preview and
the acceptance are two separate requests and the invitation may have been
revoked in between.

Inviting is a dialog on the Team page rather than a form sitting permanently
below the roster: it is an occasional act, and the roster is what the page is
for. Revoking an open invitation and removing someone's access both ask for
confirmation first — destructive actions are marked by a question and by their
words, not by being red.

---

## The first Owner

Somebody has to exist before anybody can be invited. `scripts/bootstrap-owner.mjs`
does that once:

```bash
STUDIO_OWNER_EMAIL=… STUDIO_OWNER_NAME="…" npm run studio:bootstrap-owner
```

It refuses to run if an active Owner already exists, promotes an existing member
rather than creating a duplicate, and validates the address before writing
anything. Both variables are read once and should be removed from the
environment afterwards.

It is a script and not an endpoint on purpose. A publicly reachable bootstrap
route, or a "first user to sign in becomes the Owner" rule, is a permanent race
condition sitting on the internet waiting for whoever reaches it first.

---

## Server actions are public endpoints

Every action in `app/studio/(app)/team/actions.ts` calls `requireOwner()` before
it does anything. The fact that a button is rendered only for an Owner protects
nothing: an action is an HTTP endpoint that anyone can call with its identifier.

This was tested rather than assumed. Invoking a Team action directly with a
Member's session returns not-found and changes nothing; invoking it with no
session redirects to sign-in and changes nothing.

The same rule applies to what is fetched. The Team page loads open invitations
only for an Owner, rather than loading them and hiding them in the markup.

---

## Logging

Studio follows Build 001's rule — one-line JSON to stdout, greppable by `event`
— with one addition it must never break:

**Never logged:** magic links, invitation tokens, session tokens, verification
codes, cookie values, or anything else that grants access on its own. Email
addresses are reduced to `***@domain` by `redactEmail`.

Events: `studio.login_requested`, `studio.login_refused`,
`studio.invite_created`, `studio.invite_failed`, `studio.invite_revoked`,
`studio.invite_accepted`, `studio.invite_accept_rejected`,
`studio.invite_accept_failed`, `studio.member_deactivated`,
`studio.member_reactivated`.

None of them carries a token, and `studio.invite_accept_rejected` carries the
reason but not the token that was rejected.

---

## Configuration

By name only. Values live in Railway, never in this repository.

| Variable | Required | Notes |
| --- | --- | --- |
| `APP_URL` | Yes | Absolute origin of the deployment. Sign-in and invitation links are built from it. |
| `BETTER_AUTH_SECRET` | Yes | Signs sessions and links. Different in every environment. Rotating it signs everyone out. |
| `STUDIO_HOST` | No | The host Studio answers on at its root. Unset until the subdomain is connected. |
| `STUDIO_OWNER_EMAIL` | Bootstrap only | Read once by the bootstrap script, then removed. |
| `STUDIO_OWNER_NAME` | Bootstrap only | As above. |

`npm run env:check` reports which are missing, by name, and never prints a
value. None of these may ever be given a `NEXT_PUBLIC_` prefix, and none may
become a Docker build argument — see the note at the top of the `Dockerfile`.

---

## Design

Studio shares the public site's tokens — the same black and white, the same
white-at-opacity secondaries, the same system typeface — and none of its layout.
The public site is a gallery: one column, enormous type, air. Studio is a
working surface: a persistent rail, denser text, information first.

The public chrome is not inherited. Public routes live in an `app/(public)/`
route group with the header, footer and cursor in its layout, and the root
layout is now the document and nothing else. Before that group existed the
Studio shell rendered inside the public header with its `<main>` nested in the
public one.

Errors are designed, not raw: an expired invitation, a withdrawn one, an
already-used one and a page that is not yours to open each have their own calm
wording, shared between the page that checks a link on arrival and the form that
checks it again on submit.

---

## Open

**Build 003 changed what these cost, and Build 004 raised them again.**
Production holds real client records rather than a handful of contact-form
messages, and since Build 004 it also holds the access by which people outside
the company reach their own work. The first three stopped being housekeeping:
losing access, or losing the database, now loses the business's own data and
its clients' way in. Ordered by what it would actually cost to be wrong.

1. **Production has one Owner.** The bootstrap script refuses to run while an
   active Owner exists, so a lost mailbox means editing the database by hand to
   get back into a Studio that now holds client work. Invite a second Owner,
   ideally on a different mail provider, which also insures against the next
   item. **This is the one to do first.**
2. **Sign-in depends on one email arriving.** No password, no fallback: a link
   in a spam folder is a locked door. Confirm SPF and DKIM cover the sending
   domain for Studio's mail, not only contact notifications. Since Build 004
   this is also a client-facing risk: a Workroom invitation that does not
   deliver is a client who cannot reach work that exists.
3. **There is still no recovery time objective.** The first rehearsal proved the
   mechanism and measured nothing. The next one must time the restore, and must
   now also verify the business-core tables, `audit_events` *with its triggers*,
   the `version` triggers, the migration ledger and an application boot against
   the restored copy — see [`restore-rehearsal.md`](./restore-rehearsal.md),
   which lists them.
4. ~~**Rate limiting is in memory.**~~ **Closed in Build 004.** Both auth
   instances now use Better Auth's database-backed limiter, each in its own
   table — `auth_rate_limits` and `client_rate_limits`. The counters survive a
   deploy and would survive a second instance. Separate tables because both
   expose `/sign-in/magic-link` and the limiter keys by path and address.
5. **`npm run audit` still reports four moderate findings** that the runtime
   image does not carry, because the Dockerfile prunes the package they come
   from. Re-check when Better Auth stops asking for `drizzle-kit` as an
   optional peer; see [`database.md`](./database.md).

### Not open, and worth saying so

Two defects found during Build 003 hardening are fixed and held by tests: a
record's name travelling in the response that refused the request, and a
double-press on an inquiry creating one lead but two people. Neither reached
production.

Build 004 found a third, in Build 002's own code: a mail **delivery** failure
threw, which turned a real address into a 500 and an unknown one into a 200 —
an enumeration oracle in the one endpoint most carefully written not to be one.
Both instances now log the failure and answer identically.

Build 004's hardening pass found a fourth in the same place: identical answers
that took visibly different times, because only a known address went on to call
the mail provider. Delivery now happens outside the request and the two are
indistinguishable; see `lib/auth-delivery.ts` for the measurements before and
after.

**These two are not like the first two.** The Build 003 findings were caught
before that build was promoted. These were in Build 002's shipped code, so both
ran in production from Build 002 until Build 004 was promoted on 2026-09-16.
Saying "found and fixed" without saying "and it was live for two builds" would
be the more comfortable sentence and the less true one.

### Clients are not staff, and the separation is structural

Build 004 put people outside the company behind their own Better Auth instance:
separate tables, cookie, secret and API path. A client session cannot satisfy
`requireStaff`, a Studio session cannot open a Workroom, and holding both at
once confuses neither. Signing out of one leaves the other alone. See
[`client-auth.md`](./client-auth.md), and `tests/workroom-isolation.test.ts`,
which asserts all four against a running deployment.

---

## Not built, deliberately

No files, invoices, payments or notifications. Workrooms arrived in Build 004
and are in production; the Studio side of them is one item under DELIVERY and
`workroom_activity` is the client-facing timeline they brought with them.

**That timeline is not audit, and the separation is permanent.** Audit is who
changed what and is append-only; activity is what happened around a client or a
project and is a product surface. They are two tables and `audit_events` must
never be repurposed as one — the reasoning is in [`audit.md`](./audit.md) and
the model in [`activity.md`](./activity.md).

No merging of duplicate contacts, no per-record permissions, no value or
forecast on a lead. No password reset, because there is no password. No
self-service sign-up, ever.

**Ownership is not authorization.** `owner_id` on a lead or a project says who
is responsible and nothing about who may see it. Every active staff member sees
the whole business core, because a studio this size covers for each other and
hidden records make that impossible.
