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
**Build 001**, **Build 002**, **Build 003** and **Build 004**. **Build 005's
architecture is locked in `docs/delivery.md`. Stage A — storage and Files —
is verified on beta against the real Railway bucket, viewer included. Stage B —
Presentations and immutable Revisions — is now **manually accepted on the real
Railway beta deployment**: draft → Preview → publish Revision 1 → client
Revision 1 → edit the private draft → client stays on Revision 1 → publish
Revision 2 → client Revision 2 → client Previous versions → Studio's frozen
Version 1 → unshare refused → archive refused. The record is
`docs/delivery.md`. **Stage C — Reviews — exists at the schema level only**:
migration `0006_reviews.sql` is applied on beta, `lib/db/reviews.ts` does not
exist, there is no client or Studio surface, and nothing reads or writes the
two tables. Approvals has not begun. Build 005 is **not promoted**: production has no bucket, the sweep is
unscheduled and there is no per-object backup strategy, so production remains
Build 004.**
These are facts about the running system, not proposals. Changing any of them is
a deliberate decision, not a cleanup.

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
  sharing one address can never both hold access.
- **A refusal about the client identity is made where somebody can act on it.**
  Two things stop an acceptance for reasons unrelated to the invitation — the
  address already belongs to another Contact's identity, and the person's
  sign-in was switched off after the link was sent. Both are checked by
  `inviteToWorkroom` before a link exists, by `inspectWorkroomInvitation`
  before the landing page promises entry, and by the acceptance, whose
  insert-conflict handling stays the last line against a race. A landing page
  must never promise what the next tap refuses: beta found exactly that, and
  `docs/client-auth.md` records it. `unavailable` means only "the Workroom is
  not published"; `access_off` and `email_taken` are their own reasons.
- **The acceptance endpoint is driven over HTTP by a test, not only its domain
  function.** Everything about invitations was tested at the domain layer and
  nothing had touched the endpoint, so the rate limiter in front of it and the
  session write after it were the untested parts of the one journey that
  matters most to somebody outside the company. Three layers can refuse a tap —
  limiter, acceptance, session write — and each says the thing that is true;
  after a session failure their access is real and a sign-in link works.
  `workroom.invite_accept_attempted` is logged before anything is decided, and
  its presence or absence is the diagnosis.
- **An invitation's acceptance budget belongs to the invitation, not the
  address.** Ten refusals per five minutes per token fingerprint, cleared by a
  success; Better Auth's address limiter is widened to 60 a minute and left as
  a flooding backstop only. Keying it on the address meant a client behind a
  carrier NAT locked themselves — and strangers — out by retrying, and a
  resent invitation inherited the old one's failures. The key is `inv:` plus a
  fingerprint derived differently from `token_hash`, and the raw token is never
  written anywhere. See `docs/client-auth.md`.
- **An invitation is single use, and it is not how a client comes back.** It
  attaches an identity to a Contact and grants a membership, once. Every later
  entry is the ordinary client sign-in at `/workrooms/sign-in`, which lands in
  the Workroom because the membership is already there. The one accommodation
  is a repeat press that already holds a session for that same Contact: it is
  told where to go, mutates nothing and consumes nothing.
- **The beta runtime variable is `CLIENT_AUTH_SECRET`, spelled in full.** Beta
  ran with `CLIENT_AUTH_SECRE` and every client acceptance failed for a reason
  that had nothing to do with invitations; it was corrected in Railway and
  redeployed, and the real journey succeeded straight afterwards. A missing
  secret is a hard refusal, not a quiet default, and it looks like an
  application fault from outside. `npm run env:check` is the first thing to run
  when a whole flow fails at once rather than for one person.
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
  There are **no member roles**: any active member may review and approve.
- **Client-facing routes are nested under `/workrooms/...`, never at the root.**
  The blueprint once reserved `/files/...` and `/approve/...` as root
  namespaces; that is revised. `middleware.ts` scopes the private cache headers
  to `/workrooms/:path*` and `robots.txt` disallows that one prefix, so a second
  private namespace would fall outside both silently. Still no new subdomain,
  and **never `files.yiddiweller.com`**.
- **Build 005 delivery objects attach to `workrooms.id`, never to a Project**,
  and every child table carries `workroom_id` inside a **composite foreign key**
  so PostgreSQL itself refuses a cross-Workroom reference. The model is
  `docs/delivery.md`.
- **An approval names a Presentation Revision, never a Presentation.** Revisions
  and their items are immutable; a terminal approval refuses UPDATE, DELETE and
  TRUNCATE. A new decision about changed work requires a new Revision.
- **A published Revision holds one Review round, ever, and the row cannot be
  deleted.** `UNIQUE (presentation_revision_id)` plus a trigger refusing DELETE
  and TRUNCATE — a unique constraint somebody can delete their way around is
  not a rule, and the rows that look most disposable (withdrawn, closed empty,
  never answered) are exactly the lifecycle record. A closure by a newer
  Revision is terminal and cannot be relabelled, in one write or two.
- **A Review note's anchor belongs to the exact Revision reviewed, and
  PostgreSQL proves it.** The note carries `presentation_revision_id` as well
  as `presentation_review_id`, and two composite foreign keys pivot on it — so
  a note on Revision 2 cannot reference an item from Revision 1, inside one
  Workroom. Tenancy alone had allowed exactly that. **Replies are depth one**,
  by a foreign key on `(id, is_root)`, not by the interface. **Staff cannot
  open a feedback item**, by CHECK. The model is `docs/delivery.md`.
- **A removed Review note is a tombstone, and no projection returns its body —
  staff included.** Removal writes `removed_at` beside the text, never over it,
  so the record is not falsified and the immutability trigger needs no
  exception; the window is fifteen minutes, it closes the moment anyone
  replies, and it can never be undone. A staff-readable "removed" comment is
  not a removal, and a second projection to make one possible is the drift
  Stage A and Stage B were both caught by.
- **A CHECK constraint passes when its expression is NULL.** Only `false` is a
  violation, so `x IN (…)` against a NULL column makes a constraint accept what
  it was written to refuse — `0006`'s closure rule did exactly that before a
  test caught it. Write branching shape rules as `CASE … END`, and assert them
  against PostgreSQL rather than reading them.
- **A client only ever sees a `ready`, `shared`, unarchived File — inside a
  Presentation exactly as in the Files list, and inside a Revision published
  years ago exactly as today.** There is one predicate, `clientVisible()`, and
  Stage B does not widen it, union it, or add a route that reaches a file
  another way. **Publishing a Revision shares the Files it references**, in the
  same transaction, which is what keeps that sentence true. **A File in a
  Revision of a `published` Presentation cannot be unshared**, and a File in any
  Revision cannot be archived. Retracting what a client was shown is
  `unpublish`, never `unshare`.
- **A Presentation Revision row exists if and only if it was published.** So
  "may the client open Revision 2?" is answered by the row existing, never by a
  flag. Clients may revisit every published Revision; the latest is primary and
  the rest stay behind one quiet control.
- **Publishing is one transaction and its optimistic version check is the last
  write in it, deliberately.** By then it has shared files, written activity and
  inserted two immutable tables, so the gate has to sit where a failure unwinds
  all of it. Refusals inside that transaction throw rather than return, because
  returning an `Outcome` from a transaction callback commits it.
- **Revision numbers are allocated under `SELECT … FOR UPDATE`, never by reading
  a MAX.** The row lock serialises publishes, the `version` check refuses the
  loser, and `UNIQUE (presentation_id, revision_number)` is the last line.
- **A Presentation draft is one document and carries one version.** Retitling,
  rewording a note and reordering all pass the Presentation's `version`.
- **A Revision stores what was delivered; each surface supplies its own file
  routes.** Paths are not content. The client's presentation uses
  `/workrooms/{room}/files/...`, which requires `ready` + `shared` + unarchived +
  membership; Studio's preview and its view of a published version use
  `/studio/workrooms/{id}/files/...`, which requires staff and the file's own
  Workroom and applies **no** visibility filter. Neither borrows the other's:
  a Studio session on a `/workrooms/...` route is sent to the client sign-in
  exactly as a stranger is. Found by manual beta acceptance — a draft's internal
  image rendered broken in Preview — and fixed at the cause rather than by
  sharing the file early or loosening `clientVisible()`. **Retested on beta and
  it passes**, with the File still `internal` afterwards.
- **Staff Preview renders the *draft* through the same component and projection
  as the client page, and says so.** For a published Presentation it is
  deliberately not what the client currently sees — that is the current
  Revision. One component, never a second copy of the markup: the Stage A
  Preview drift was a real defect, not a near miss.
- **Beta has the five `BUCKET_*` variables through Railway Variable References
  and its bucket is verified private; production has none of it.** Missing them breaks the Files routes and nothing else —
  the public site, Contact, Studio sign-in, the business core and the Workroom
  overview never read them. `scripts/check-env.mjs` reports them as their own
  group, because absent means "not there yet" in production and "broken" on beta.
- **File bytes live in a private Railway Storage Bucket, never in PostgreSQL,
  never on a Railway volume and never in the container filesystem.** The storage
  layer is written against S3, not against the vendor — `lib/storage/*`, an
  endpoint and a credential — so the provider is a configuration change. Uploads
  land in `pending/`, are verified by an authenticated HEAD, then **server-side
  copied** to a permanent key that is never a presigned upload target. Beta and
  production use separate buckets with separate credentials.
- **Object storage is a second durability surface and PostgreSQL's PITR does not
  cover it.** A database restore returns every file's metadata and none of its
  bytes. The bucket has **no versioning, no object locks, no lifecycle
  configuration and no native snapshots** — so overwrite is defended by
  architecture, deletion is not defended at all, and abandoned uploads are swept
  by the application rather than expired by the bucket — and **that sweep is
  built but not scheduled**, so until it is, abandoned uploads accumulate. A
  per-object backup strategy is open, not solved, and is **required before
  Build 005 reaches production**: `docs/restore-rehearsal.md`.
- **`npm run storage:verify` is run per environment, by hand, before trusting
  Files there.** Beta has passed it, including the check no local test double
  can answer — an unsigned GET being refused. Production has not, because it has
  no bucket.
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
- **Confirmations are ours, never the browser's.** No `window.confirm`, `alert`
  or `prompt` anywhere a person can reach. One `ConfirmDialog` on native
  `<dialog>`: a title naming the action, one sentence on the consequence, and a
  button repeating the verb — never "Are you sure?" and never "OK". Destructive
  is the outlined button rather than a colour, Cancel holds the focus, and a
  test scans the source so a native one cannot come back. Confirm consequence,
  not every edit: `docs/studio-design.md`. Verified by hand on beta — publishing
  reads *Publish presentation? / One file will also be shared with the client. /
  Cancel · Publish.*
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
