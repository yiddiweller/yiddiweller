# Builds

One sequential build number for the whole platform. Not two tracks.

`Build 001`, `Build 002`, `Build 003`, and so on. Beta and production share the
same sequence: a build keeps its number as it moves from one to the other, so
two environments running the same number are running the same thing.

The commit SHA remains the technical source of truth underneath. This file is
the human-readable record, and it is the whole system. No version database, no
tooling, nothing to keep in sync.

---

## Current state

| Environment | Build | Commit |
| --- | --- | --- |
| Production | **Build 004** | `6b4ca20` |
| Beta | **Build 004** | `6b4ca20` |

Both environments sit on the identical commit. Build 004 was promoted on
2026-09-16 by fast-forward, so there is nothing on one that is not on the
other, and no build is awaiting promotion.

The commits above are what each branch actually points at, which is not always
the commit that claimed the number. A documentation commit changes nothing
about the running system, so it claims no number and does not move the build —
Build 003's own commit was `1e4af21`, and production ran `8d0fd80` on top of it
until this promotion.

---

## How a number moves

A build number is claimed once, when work is ready for beta, and does not
change afterwards.

```
work merged to beta   →  Build 002 claimed
                         beta = Build 002, production = Build 001
approved and promoted →  production = Build 002
                         both environments now Build 002
next meaningful work  →  Build 003 claimed
```

Beta running a higher number than production is the normal state during
testing, not a discrepancy. It means exactly one thing: a build is being
verified and has not been promoted yet.

**A number is never reused and never reassigned.** If a build is abandoned
rather than promoted, its number is retired with it and the next work takes the
following number. Renumbering would break the one property that makes this
useful, which is that a number always refers to the same code.

---

## What earns a number

A build number marks something worth referring to again in conversation, a
changelog, or a release note.

**Earns one:** a feature, a schema change, a security or infrastructure change,
an accessibility or performance fix people would notice, anything that changes
what the site or platform does.

**Does not:** documentation, comments, a typo corrected and redeployed, or
repeated deploys of the same code. If nothing about the running system is
different, nothing has been built.

When in doubt, do not claim a number. An unnumbered deploy costs nothing; a
number that refers to nothing in particular makes every other number less
trustworthy.

---

## Build log

### Build 005 — Delivery

**Stage A is verified on beta.** Not released, not promoted, and Build 005
claims no production state. Production has no bucket and has not been touched by
Build 005 at all.

The architecture is locked in [`delivery.md`](./delivery.md). Stage A builds the
storage adapter and Files; Presentations, Reviews and Approvals exist as schema
and nothing else.

- **File bytes live in a private Railway Storage Bucket**, reached through an
  S3 adapter named after nothing. Beta has its five bucket variables through
  Railway Variable References; **production has none and gets none until
  Build 005 is promoted.**
- **A row exists before its bytes.** An upload reserves a `pending` row, the
  browser sends bytes straight to storage, and an authenticated `HEAD` decides
  whether anything becomes `ready` — because a presigned PUT cannot enforce a
  size. Then a server-side copy to a permanent key the browser has no URL for,
  and only then the row.
- **Downloads are a 302 to a sixty-second signed URL**, authorized by one query
  that carries membership, published state, ownership, readiness, visibility and
  archive state together.
- **A shared file is looked at, not only fetched.** One `viewerKind()` maps a
  stored content type to exactly one of five outcomes — image, PDF, video,
  audio, or a download card — and one `FileViewer` component renders all five
  for clients and staff alike. Matches are exact, never by prefix, so
  `image/svg+xml` stays a download card: an SVG served from our own origin is
  stored XSS. Inline URLs last fifteen minutes because seeking in a video is a
  fresh request against the same URL; downloads still last sixty seconds. Full
  view never crops.
- **The bucket expires nothing**, so `npm run storage:sweep` does — bounded,
  idempotent, object before row, and refusing any key that is not `pending/`.
  **Not yet scheduled.**
- Seven tables, additive migration `0004_delivery.sql`, rehearsed against a
  realistic Build 004 database: every row preserved, upgraded schema identical
  to one built from scratch, Build 004 code still writes cleanly to it.

**Beta acceptance.** Migration `0004` deployed and applied. `npm run
storage:verify` was run **inside the real beta app container against the real
Railway Storage Bucket** and every check passed: presigned PUT accepted,
authenticated HEAD returning a real size and ETag, server-side `CopyObject`,
presigned GET returning the correct bytes, forced `attachment` disposition
honoured, multipart upload, pending deletion, a clean 404 for a missing object,
and **an unsigned GET refused — the bucket is private.**

By hand: Studio Files loaded, `unnamed.png` uploaded, 1.4 MB stored, default
`internal`, Share moved it to `shared`. Then — after `5f3d206` — the client-safe
Preview showed the Files section, the file, a safe type and size, `Open files →`
and the `file.shared` Activity line, with one shared `WorkroomOverview`
component keeping the Preview and the real client overview aligned.

**What Stage A has still not done**, and none of it is blocked by the above:

- **No production bucket exists**, and none is created until promotion.
- **The sweep is not scheduled.** Until it is, abandoned uploads accumulate.
- **No per-object backup or replication strategy**, which is required before
  Build 005 reaches production — see [`restore-rehearsal.md`](./restore-rehearsal.md).
- **The viewer has not been accepted on beta by hand.** It passes the full
  automated suite, the responsive sweep and the quality gate locally; the
  by-hand beta acceptance recorded above predates it.
- **Stage B has not begun.** Presentations, Reviews and Approvals exist as
  schema and are read by nothing.

---

### Build 004 — Client workrooms

Commits `53d07fd` … `6b4ca20`. **In production, verified.** Promoted
2026-09-16 by fast-forward, so production and beta sit on the identical commit
`6b4ca20bafb69db794636baf8b87798b95f806c2`.

**Production acceptance.** The deployment succeeded, migration `0003` completed
successfully, and the Next.js application started. Studio is healthy on
`studio.yiddiweller.com` and **Workrooms** appears in its navigation under
DELIVERY. A controlled test Client, Contact and Project were created against
the live service, a Workroom was created from that Project, its draft state
behaved as designed, and publishing it worked.

Those four records are still in production and are the only rows there that are
not real business data. Archive them when they have served their purpose —
archive, never delete, like everything else in the business core.

**What production acceptance deliberately did not repeat.** After publishing
the production test Workroom, the invitation → acceptance → client sign-in →
revocation journey was **not** run again against production. It was exercised
in full on beta, recorded immediately below, and this entry does not claim
otherwise. Anybody reading this later should treat that journey as verified on
beta and unproven in production until somebody runs it there.

**Beta acceptance.** Exercised by hand against the running beta deployment:
creating a Workroom from a Project and only from a Project, publishing and
unpublishing it, previewing it as a client sees it, inviting a contact,
opening the invitation link more than once without spending it, accepting it,
signing in and out, requesting a fresh sign-in link, reaching one's own
Workroom and being refused somebody else's, the index listing only what the
viewer may open, revoking access and having it take effect on the next
request, restoring it without a new invitation, an archived Workroom
disappearing from the client's world, a contact with live access refusing to
be archived, a project with an open Workroom refusing to be archived, a
project status change appearing in the client's timeline, the Studio surfaces
for all of it, and the public site and contact flow unchanged throughout.

The five that matter most, and where each was proven:

| | Beta | Production |
| --- | --- | --- |
| Invitation delivery — the email arrived | **passed** | not repeated |
| Invitation acceptance | **passed** | not repeated |
| Client reaches their own Workroom | **passed** | not repeated |
| Client sign-out and sign-in again | **passed** | not repeated |
| Membership revocation takes effect immediately | **passed** | not repeated |

"Not repeated" is not "failed" and not "unknown in principle" — it is a
deliberate choice about how far to exercise a live service with a test client,
recorded so nobody later reads the production column as passed.

Phase 4, and the first client-facing build. Each project can now have one
private space the client is invited into. Nothing about the public site
changed, and nothing about Studio changed except gaining a way to run these.

- **A Workroom is not the Project.** It has its own client-facing title and
  summary, written for the client, and `projects.description` and every `notes`
  field stay where they were written. Nothing reaches a client surface except
  through one named projection.
- **A client is never a row in `user`.** Clients have their own Better Auth
  instance: separate tables, cookie name, secret and API path. A client session
  cannot satisfy a Studio guard, a Studio session cannot open a Workroom, and
  holding both at once confuses neither.
- **Access is explicit, per person, per Workroom.** Being a contact at the
  client grants nothing. Revoking is immediate, because membership is read on
  every request rather than trusted from a session, and it never signs anybody
  out of their other Workrooms.
- **Invitations are single-use, expiring, revocable and resendable**, stored as
  a digest, at most one open per person per Workroom. A `GET` never consumes
  one — mail scanners open links before people do — so the link renders a page
  and a `POST` accepts. Acceptance is one transaction and the session is issued
  only after it commits, by Better Auth's own primitives.
- **The URL is an opaque 26-character identifier**, not the row's UUIDv7, whose
  first bits are the moment the work began. It is unguessable, and it is not
  authorization: every read behind it checks membership server-side.
- **Activity arrived as its own table**, five values from a fixed vocabulary and
  two short labels, with no `metadata` column at all — there is nowhere for an
  internal note to be pasted. Audit records the same business events with the
  actor and the field names; neither reads the other.
- **Audit learned who a client is**, by a second actor column rather than by
  pretending a client is a staff row.
- Rate limiting moved to Better Auth's database-backed limiter for **both**
  instances, in separate tables, which closes an item open since Build 002.
- Fixed in Build 002's own code while building this: a mail **delivery** failure
  threw, turning a real address into a 500 and an unknown one into a 200 — an
  enumeration oracle in the endpoint most carefully written not to be one.

**Hardening after beta acceptance.** Five changes, each from something
measured rather than suspected.

- A client sign-in could be sent to `/studio/clients`. Better Auth refuses
  another origin but cannot know that `/studio` is a second product on this
  one, so the rule is now stated where it belongs: an authentication flow for
  a client may only land on a path under `/workrooms`. Both halves carry a
  `callbackURL` and both are sanitised — fixing only the POST body left the
  verification `GET` still redirecting out of the client world.
- Two invitations to the **same person**, for different Workrooms, accepted in
  the same moment, crashed: neither transaction saw the other's uncommitted
  identity and one died on the unique index. Fixing it exposed a second
  collision that is not a race at all — `contacts` does not make email unique,
  a client identity's email does, so two Contacts sharing one address could
  never both hold access and were reaching the same crash. Both are now a
  reuse or a clean refusal.
- Both sign-in endpoints returned the same status and body for a known and an
  unknown address, and took visibly different times doing it: 28–76ms against
  ~15ms, because only one went on to call the mail provider. Delivery is no
  longer part of the request, and the two are now 17.6ms against 16.0ms with
  overlapping ranges.
- `robots.txt` said `Disallow: /workrooms/`, which is a prefix match and so
  left `/workrooms` itself — the index of everybody's private spaces —
  uncovered. The trailing slash is gone.
- The invitation races are now asserted on every table a successful acceptance
  writes to, rather than on the primary record, and one test proves audit and
  activity roll back with the data by making the last write fail.

### Build 003 — Business core

Commits `e64eaeb` … `1e4af21`. **In production, verified.** Promoted
2026-09-15 by fast-forward, so production and beta sit on the identical commit.

The promotion carried `f22b8f8` across with it — the commit that recorded Build
002's production verification, which claimed no number of its own.

**Production acceptance.** The deployment succeeded, `migrate.complete` was
confirmed in the deploy log, and the seven business-core tables were created
while the Build 001 and 002 tables and their data were left exactly as they
were. The public site stayed operational and visually unchanged throughout, the
contact flow kept working, `yiddiweller.com/studio` and
`yiddiweller.com/studio/clients` still answer 404 on the public host, and
`studio.yiddiweller.com` stayed live for the whole promotion. Clients, Contacts,
Leads, Projects, inquiry → Lead, Lead conversion, the relationships, Search,
Audit and archive protection were each exercised against production, and an
end-to-end business workflow passed. **No new production environment variable
was required.**

Phase 3. The first build holding real business data: Clients, Contacts, Leads
and Projects, the two flows that connect them, and the audit foundation that
had to arrive with them rather than after them. Nothing about the public
experience changed.

- Four concepts, never blurred: a Contact is a person, a Client is the
  relationship, a Lead is an opportunity, a Project is work. One table never
  means two of them. The model is `docs/business-core.md`, written before the
  schema and reviewed against fourteen real situations before a migration was
  generated.
- People attach to clients and to projects through relationship tables, so the
  same person can act for two clients without being duplicated. At most one
  primary each, enforced by a partial unique index rather than by care.
- An inquiry becomes a Lead once, by a deliberate act, in one transaction. The
  inquiry itself is never edited: an unprocessed inquiry is one with no Lead
  pointing at it, so there is no second source of truth to disagree with.
- Converting a Lead writes the client, the project, the relationships and the
  Lead's own outcome together or not at all, and only ever once. A Lead can be
  won before there is a project to point at.
- Optimistic concurrency on every editable record, so a save composed against a
  row somebody else has since changed is refused rather than silently
  overwriting them. It compares an integer `version`, because a `timestamptz`
  cannot be compared honestly across the JavaScript boundary — the first design
  compared `updated_at` and would never have matched.
- Append-only audit, enforced by PostgreSQL against `UPDATE`, `DELETE` and
  `TRUNCATE`, written in the same transaction as the change it describes. It
  records that something changed and never what it now says.
- Archive and restore rather than delete, refused where it would leave the data
  nonsensical — a client with live work, a person who is somebody's only named
  contact, a project whose client is archived.
- One search across all four, four indexed queries in PostgreSQL, no search
  service.
- Home now answers "what needs attention" from conditions that are true of
  rows — an inquiry with no lead, a follow-up whose time has passed, live work
  past its target — never from a flag somebody has to remember to set.
- Navigation grew its second group, Business and Studio, and hides what a
  Member's role cannot reach.
- Fixed while building it: the Studio shell's grid track was a bare `1fr`,
  which refuses to shrink below its content, so the first wide element — the
  pipeline board — made every page scroll sideways on a phone.

Two further defects were found during final hardening, after beta acceptance,
and both are fixed:

- **A record's name travelled in the response that refused the request.**
  `generateMetadata` runs independently of the page component, so a guarded page
  still produced its title, and an inactive member's redirect to the sign-in
  page carried `Northwind Trading — Studio`. All four detail pages now check the
  caller before reading, and a test holds it there.
- **A double-press on an inquiry created one lead but two people.** Both
  transactions reached the "we do not know this person" branch and inserted a
  contact; only one won the lead index, and the loser's contact was committed.
  The losing transaction now rolls back entirely and the caller is sent to the
  lead that exists.

### Build 002 — Studio foundation, authentication and design system

Commit `544e7bb`. **In production, verified.** Promoted 2026-09-15 by
fast-forward, so production and beta sit on the identical commit.

A build keeps one number while it is being finished: the authentication work
and the design system that completes it are both Build 002, and the refinement
commits between them claimed no number of their own.

Phase 2. The first build with a private side: Studio, the internal team world,
served by the same application and told apart by `Host`. Nothing about the
public experience changed.

- Magic-link authentication, invite only. No sign-up form, no password, no
  social provider. A user row is created by accepting an invitation or by the
  one-time owner bootstrap script, and by nothing else.
- Two roles, Owner and Member, and a separate active/inactive status.
  Deactivating deletes live sessions, so access ends immediately.
- Single-use invitations, stored as a digest and expiring in seven days.
- Host routing: Studio at the root of its own host once the subdomain is
  connected, `/studio` on beta and localhost, and 404 on the public host.
- Server-side authorization on every page, layout and action.
- Public routes moved into an `app/(public)/` route group so Studio stops
  inheriting the public header, footer and cursor. No URL changed.
- The runtime image no longer carries drizzle-kit, esbuild and tsx, which an
  optional peer dependency had pulled into it.
- The permanent Studio interface: a left rail on desktop and a drawer on small
  screens, one page architecture every future module plugs into, and a token
  set, component language and accessibility standard recorded in
  `docs/studio-design.md`. Locked before the modules exist so that no later
  build has to redesign the application to add a screen.
- Times render in the reader's own timezone, with the server sending labelled
  UTC so nothing is ever quietly wrong.
- Authorization is called inside the component that reads, before it reads.
  Measuring a guarded page showed that a guard in a parent layout does not stop
  its page running — an anonymous request came back with the protected data in
  the body — and that a `loading.tsx` above a guarded page turns a refusal into
  a 200. Both are now rules, and Studio has no loading boundary.

Requires `APP_URL` and `BETTER_AUTH_SECRET` in every environment that serves
it, and one migration, `0001_studio_staff.sql`, which the deploy applies itself.

**Promotion, 2026-09-15.** Two stages, as planned. The code went first with
`STUDIO_HOST` unset, so Studio was unreachable in production while the deploy
and the migration were verified: five Studio tables created, existing inquiry
data intact, the public site and the contact flow unaffected, and
`yiddiweller.com/studio` still answering 404. Then
`studio.yiddiweller.com` was connected through Railway and Namecheap, verified
by Railway, and `STUDIO_HOST` was set. The first Owner was bootstrapped,
magic-link sign-in was confirmed on the real domain, and Home, Team and Settings
were checked by hand.

`APP_URL` is `https://studio.yiddiweller.com` in production — the Studio origin,
not the public one, because Better Auth builds its links and scopes its cookie
from it. No code change was needed to connect the subdomain.

A production database restore had been rehearsed successfully before promotion;
see [`restore-rehearsal.md`](./restore-rehearsal.md) for what it established
and what it did not.

---

### Build 001 — Phase 1 production foundation

Commit `681fc8e`. In production, verified.

The first release with a real backend underneath the site. Nothing about the
public experience changed except two accessibility corrections.

- PostgreSQL becomes the system of record for contact inquiries. Before this,
  an inquiry's only copy was an email in one inbox.
- Drizzle ORM, committed SQL migrations, and a server-only data layer.
- The image is built from a repository Dockerfile instead of Nixpacks, so no
  application secret is written into image metadata.
- Node 22 pinned by the base image.
- Two WCAG AA contrast failures corrected at the smallest compliant adjustment.
- Separate Railway `production` and `beta` environments, each with its own
  PostgreSQL service.

Everything before Build 001 is unnumbered. It predates the convention, and
numbering it retrospectively would invent history.

---

## Recording a build

Add its entry to the log above when it reaches beta, with the commit and what
changed. Update the current state table when it is promoted. That is the whole
procedure.

Tagging is optional and adds nothing the log does not already carry. If you
want one for a particular build, keep the name in the same sequence:

```bash
git tag -a build-002 <commit> -m "Yiddi Weller — Build 002"
git push origin build-002
```

Railway and GitHub go on showing their own commit and deployment identifiers.
Nothing here changes or competes with them, and no interface displays the build
number yet. None should be built until a phase asks for one.

---

## Superseded

An earlier draft of this file proposed two parallel sequences: `Beta 001`
upward for beta, and semantic versions such as `v1.0.0` for production. That is
no longer the convention and should not be reintroduced. It required translating
between two names for the same code, and semantic versioning promises a
meaning about compatibility that a studio platform with one deployment target
does not need to make.

A `v1.0.0` tag was created locally during that draft and never reached GitHub.
It has been deleted. No published tag or reference carried the old scheme.
