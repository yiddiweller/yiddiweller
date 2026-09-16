# yiddiweller.com

The public site of Yiddi Weller, and the foundation of the YIDDI WELLER LLC
platform. Next.js App Router, TypeScript, CSS Modules, PostgreSQL via Drizzle,
Resend, built from the repository Dockerfile and deployed on Railway. Setup is
in `README.md`; architecture in `docs/`.

## Branches: always update both

| Branch | Reached at                        | Railway variable   |
| ------ | --------------------------------- | ------------------ |
| `main` | `yiddiweller.com`                 | none               |
| `beta` | `yiddiweller-beta.up.railway.app` | `SITE_ENV=preview` |

Beta uses the hostname Railway generated. It has no custom subdomain and is not
getting one: a preview nobody links to does not need a pretty address, and
`beta.yiddiweller.com` would be one more DNS record to keep correct.

**Every change lands on both branches.** The preview must never fall behind the
live site. Work on `beta`, push it for review, then fast-forward `main` onto the
same commit once it is approved:

```bash
git push origin beta
git checkout main && git merge --ff-only beta && git push origin main
git checkout beta
```

Both branches then sit on the identical commit. Never ship to `main` something
that has not been on `beta` first, and never leave `beta` behind `main`.

## Platform state — settled, do not re-litigate

**Phases 1, 2, 3 and 4 are complete and verified in production**, released as
**Build 001**, **Build 002**, **Build 003** and **Build 004**. Build 005 has not
begun. These are facts about the running system, not proposals. Changing any of
them is a deliberate decision, not a cleanup.

- **PostgreSQL is the system of record for contact inquiries.** Email is a
  notification, not the record. An inquiry is persisted before it is emailed.
- **Clients, Contacts, Leads and Projects are four concepts and one table never
  means two of them.** A Contact is a person, a Client is the relationship, a
  Lead is an opportunity, a Project is work. The model is
  `docs/business-core.md` and it is the source of truth, not the schema file.
- **`inquiries` is never edited to say it was handled.** An unprocessed inquiry
  is one with no Lead pointing at it. Do not add a `processed` flag.
- **Optimistic concurrency compares an integer `version`, never `updated_at`.**
  PostgreSQL keeps microseconds and a JavaScript `Date` does not, so a timestamp
  comparison never matches. A trigger raises the version on every update.
- **`audit_events` is append-only and PostgreSQL enforces it** against `UPDATE`,
  `DELETE` and `TRUNCATE`. It records that something changed, never what it now
  says: no notes, no messages, no free text, no tokens. It is not the future
  client-facing activity feed and must never be repurposed as one.
- **Nothing in the business core is deleted through the interface.** Archive and
  restore, Owner-only, refused where it would leave the data nonsensical.
- **`generateMetadata` is a second render and the page's guard does not cover
  it.** A refused request still produces a title, and that title travels in the
  refusal. Any `generateMetadata` that reads a record checks the caller first —
  with `currentStaff`, falling back to a generic title. Measured, not theorised:
  see `docs/studio.md`.
- **Production now holds real client data.** Clients, Contacts, Leads and
  Projects are live business records, not test rows. Treat every operation
  against the production database accordingly. The one exception is the small
  set of Client, Contact, Project and Workroom rows created deliberately to
  accept Build 004 — the only production records that are safe to archive, and
  the reason archive exists rather than delete.
- **A client is never a row in `user`.** Clients sign in through a second,
  isolated Better Auth instance with its own tables, cookie name, secret and
  API path. A client session must never satisfy `requireStaff` or
  `requireOwner`, and a Studio session must never open a Workroom. The model is
  `docs/client-auth.md`.
- **`client_identities.email` is a verified credential, not a business field.**
  Editing `contacts.email` never moves somebody's access. Changing an access
  email means revoke and re-invite, deliberately.
  It is also unique, while `contacts.email` deliberately is not, so two Contacts
  sharing one address can never both hold access — the second acceptance is
  refused rather than crashed.
- **A client authentication flow may only land under `/workrooms`.** Better
  Auth refuses another origin; it cannot know `/studio` is a second product on
  this one. Every `callbackURL` is sanitised on both halves of the flow, in
  `lib/client-auth/redirect.ts`.
- **Neither sign-in endpoint may reveal an address by how long it takes.**
  Delivery happens outside the request for exactly this reason; see
  `lib/auth-delivery.ts` before making it awaited again.
- **A Workroom is not its Project.** It carries its own client-facing title and
  summary; `projects.description` and every `notes` field are internal and never
  shown. Nothing reaches a client surface except through
  `toClientWorkroomView` in `lib/workrooms/view.ts`. The model is
  `docs/workrooms.md`.
- **`workroom_activity` is the client-facing timeline and has no `metadata`
  column, deliberately** — there is nowhere for an internal note to be pasted.
  It is not `audit_events` and must never be merged with it. See
  `docs/activity.md`.
- **Workroom access is explicit, per person, per Workroom.** Being a Contact at
  the Client grants nothing, and revocation takes effect on the next request.
- **Studio is live at `studio.yiddiweller.com`**, invite-only, magic-link
  sign-in, Owner and Member roles. The same application serves both worlds and
  tells them apart by `Host`: production has `STUDIO_HOST=studio.yiddiweller.com`
  set, and `yiddiweller.com/studio` answers 404 by design.
- **Production `APP_URL` is `https://studio.yiddiweller.com`**, the Studio
  origin rather than the public one. Better Auth builds its sign-in links and
  scopes its session cookie from it, and invitation links come from it too. The
  public site never reads it — its canonical URL is in `lib/site.ts`. Do not
  "correct" this to the public domain.
- **`BETTER_AUTH_SECRET` is per environment.** Production and beta have separate
  secrets; sharing one would make a beta session valid in production.
- **Railway runs two isolated environments**, `production` from `main` and
  `beta` from `beta`, **each with its own PostgreSQL service.** Beta never
  touches production data.
- **The repository `Dockerfile` is the official build system.** Nixpacks was
  removed deliberately: it declared every service variable as `ARG` then `ENV`,
  which wrote secrets into image metadata. Do not reintroduce it.
- **Node 22 is the supported runtime**, pinned by `node:22-slim`, `.nvmrc` and
  `engines`, which must continue to agree.
- **Application secrets are runtime-only and must never become Docker build
  arguments.** `RESEND_API_KEY`, `DATABASE_URL`, `CONTACT_EMAIL` and
  `RESEND_FROM_EMAIL` are supplied to the running container by Railway. If a
  build ever appears to need one, that is a design fault to fix, not an `ARG`
  to add. `SITE_ENV` is the single permitted build argument and is not a secret.
- **`SITE_ENV=preview` belongs to beta alone.** Production must never receive
  it. Both layers of the guard are prerendered, so this is decided at build
  time: beta must stay non-indexable (`Disallow: /` plus
  `noindex, nofollow, nocache`) and production must stay indexable.
- **Production PostgreSQL has Point-in-Time Recovery plus weekly and monthly
  backups, and a restore was rehearsed successfully on 2026-09-15** — PITR into
  a separate temporary service, production untouched, real inquiry data verified
  in the restored copy, and the temporary service and its volume removed
  afterwards. **No duration was measured, so there is no recovery time
  objective yet.** Procedure and full record: `docs/restore-rehearsal.md`.

Builds are numbered in `docs/releases.md`: one sequential human-readable
sequence, `Build 001` upward, shared by beta and production. A build keeps its
number as it moves between them, so beta temporarily running a higher number
than production just means something is being verified. There is no separate
beta track and no semantic versioning.

## Platform direction

[`docs/blueprint.md`](docs/blueprint.md) is the locked source of truth for the
platform. Read it before any architectural decision. The constraints most easily
broken by accident:

- **Two domains, and only two.** `yiddiweller.com` is the public and client
  world; `studio.yiddiweller.com` is the private team world. Do **not** create
  `admin.`, `dashboard.`, `app.`, `portal.`, `client.`, `clients.`, `pay.`,
  `files.`, `auth.`, `login.` or `api.` subdomains. Client payments, invoices,
  files and approvals all live under `yiddiweller.com`.
- **The internal product is called Studio.** Never Dashboard, Admin or Portal.
  Its interface system — shell, page architecture, tokens, components — is
  locked in [`docs/studio-design.md`](docs/studio-design.md). Build Studio
  screens from it rather than inventing a layout per phase.
- **Quiet outside, powerful inside.** New capability underneath must never make
  the public site busier. No Login, Portal, Billing or Dashboard links in public
  navigation.
- **Build the current phase only.** No speculative tables, no distant features.

## Design rules

- **Colour** is `#000000` and `#ffffff` only. Every secondary tone is white at
  reduced opacity, defined as a token in `app/globals.css`. Never introduce a
  grey value or an accent colour unless asked.
- **Type** is the reader's own system font, set once as `--font-sans`. Never add
  a downloaded or hosted webfont, `next/font` included. SF Pro on Apple devices,
  Segoe UI on Windows, Roboto on Android.
- **Keep it minimal.** Do not add homepage sections, marketing copy, or
  decoration unless asked. The voice stays clean, classy and understated.
- **Motion** is opacity and a small rise, nothing else, and is disabled entirely
  under `prefers-reduced-motion`.
- **Spacing** comes from `--page-x` and `--page-y`, so the gutter matches on
  every page.

## Before every push

All three must pass:

```bash
npm run typecheck && npm run lint && npm run build
```

The preview must keep search engines out. Verify that too:

```bash
SITE_ENV=preview npm run build && cat .next/server/app/robots.txt.body
# expect: User-Agent: *  /  Disallow: /
```
