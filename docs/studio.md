# Studio

The private team world. Introduced in Phase 2, released as **Build 002**.

Product decisions are in [`blueprint.md`](./blueprint.md); this file records how
Studio is actually built. Where the two disagree the blueprint wins and the
question goes back to Yiddi Weller rather than being settled in code.

---

## What exists

| Surface | Path | Who |
| --- | --- | --- |
| Sign in | `/studio/login` | Anyone. Sends a link only to staff. |
| Accept an invitation | `/studio/join?token=…` | Whoever holds a valid token. |
| Home | `/studio` | Any active staff member. |
| Team | `/studio/team` | Roster: all staff. Invitations and deactivation: Owner only. |
| Settings | `/studio/settings` | Any active staff member. Their own account. |

Home shows real inquiry counts from Build 001's `inquiries` table. Nothing else
is built: no clients, no projects, no workrooms. Those are Phase 3 onward.

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

The public host answering 404 rather than redirecting is deliberate: a redirect
would confirm that internal software sits behind that domain.

**Authorization is not done in middleware.** Every Studio page, layout and
server action checks the session against Postgres on every request. Middleware
decides which world a request belongs to; it decides nothing about who someone
is.

Until the subdomain is connected, Studio is exercised on the beta service at
`/studio`, on whatever hostname Railway gave it — today
`yiddiwellerbeta.up.railway.app`. **Nothing depends on that name.** A request
is classified as `internal` because `SITE_ENV=preview` is set on that service,
not because of its address, which is what allows beta to keep a generated
hostname and to change it without a code change. The corollary is worth
knowing: if `SITE_ENV` were ever unset on beta, that host would classify as
`public` and `/studio` would answer 404 there.

Connecting the Studio subdomain later needs three things, and no code changes
beyond the third: a Railway domain pointing at the same service,
`STUDIO_HOST` set on that environment, and Better Auth's `baseURL` moved to the
Studio origin — its session cookie is host-scoped, so a link issued for one host
cannot establish a session on the other. `studioUrl()` in `lib/env.ts` already
builds invitation links from whichever of the two applies.

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

**One honest limitation.** Because Studio renders dynamically and streams, the
response has already begun by the time `notFound()` is reached, so a Member at
`/studio/team` receives HTTP 200 carrying the "Not found." page rather than a
404 status. The page is identical either way and no access depends on the
status code — but a determined Member could tell the two cases apart. It is
defence in depth, not a secret, and the roster it protects is visible to them
anyway.

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

## Not built, deliberately

No clients, projects, workrooms, files, invoices or notifications. No activity
feed and no audit log — the convention for those is recorded in
[`architecture.md`](./architecture.md) so that whichever phase introduces them
does not invent an incompatible one. No password reset, because there is no
password. No self-service sign-up, ever.
