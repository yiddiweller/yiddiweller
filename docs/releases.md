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

| Environment | Build | Last commit that changed the running system |
| --- | --- | --- |
| Production | **Build 004** | `6b4ca20` |
| Beta | **Build 005** | `04d5c89` |

**Beta is ahead, which is the normal state during testing.** Build 004 was
promoted on 2026-09-16 by fast-forward and is what production runs. Build 005 —
Delivery, Stages A and B — is on beta, has passed manual acceptance there, and
is **not promoted**: the gates below have to close first.

**The commits above are the last ones that changed anything**, which is not
always where the branch now points. A documentation commit changes nothing about
the running system, so it claims no number and does not move the build —
Build 003's own commit was `1e4af21`, and production ran `8d0fd80` on top of it
until this promotion. Beta likewise carries documentation on top of `04d5c89`,
including the commit that recorded Stage B's acceptance.

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

**Stages A and B are verified on beta, by hand.** Not released, not promoted,
and Build 005 claims no production state. Production has no bucket and has not
been touched by Build 005 at all.

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

**Stage B — Presentations and immutable Revisions.** Implemented, and
**manually accepted on the real Railway beta deployment** — Studio on a desktop,
the client on a real phone. The full record is in
[`delivery.md`](./delivery.md#stage-b-is-verified-on-beta); the journey it
proves end to end is draft → Studio Preview → publish Revision 1 → client
Revision 1 → edit the private draft → client stays on Revision 1 → publish
Revision 2 → client Revision 2 → client Previous versions → Revision 1 → Studio's
frozen Version 1 → unshare refused → archive refused.

- **`0005_delivery_integrity.sql`**, additive, applied before the first line of
  Presentation code: `presentations.current_revision_id` bound by composite key
  to a Revision **of its own Presentation** where it previously carried no
  foreign key at all, a CHECK that `published` means there is something to show,
  and `display_name_snapshot` required on exactly the revision items that have
  one. Rehearsed on both paths — Build 004 → `0004` → `0005`, and a Stage A
  database already holding Presentation rows → `0005`. Every row preserved;
  upgraded schema byte-identical to a fresh one.
- **Publishing is one transaction with its optimistic gate as the last write**,
  so a loser unwinds the files it shared, the activity it wrote and both
  immutable tables it filled. A test forces that final statement to fail and
  asserts nothing survives.
- **Revision numbers come from a row lock, not a MAX.** Two simultaneous
  publishes produce one Revision and one clean conflict.
- **Publishing shares the files it references**, and staff are shown which ones
  before they press the button. A file a published Presentation shows cannot
  then be unshared.
- **Clients may revisit every published version**; the latest is primary and the
  rest sit behind one quiet control. Withdrawing takes the whole Presentation
  back, history included, and deletes nothing.
- **One `PresentationView` renders the client page, the historical version and
  the staff preview**, with a regression test comparing the structure of two of
  them — the `WorkroomOverview` lesson, applied before it could be learned twice.
- **Manual beta acceptance found one defect and it is fixed.** Studio Preview
  rendered a draft's internal image through the client's file routes, which
  correctly refuse anything unshared — and the same fault left a *published*
  version broken for staff, because a Studio session cannot use client routes at
  all. Paths were being treated as content and frozen into the snapshot; they
  are now supplied per surface at render time, with `clientVisible()` untouched
  and nothing shared early. Four regression tests fail against the old
  behaviour. **Retested on beta and it passes** — the internal image renders in
  Preview, the File is still `internal` afterwards, and one `PresentationView`
  over one `FileViewer` serves all three surfaces.
- **Browser-native confirmations were found during acceptance and replaced.**
  Every occurrence was classified first — needs confirming, belongs inline as
  status, or should never have asked — and what remained was rebuilt on one
  `ConfirmDialog` on native `<dialog>`. Verified by hand on beta: publishing
  reads *Publish presentation? / One file will also be shared with the client. /
  Cancel · Publish.* A source scan keeps a native one from coming back.
- **The client invitation journey failed three times on beta before it
  succeeded**, for three unrelated reasons — a landing page promising what the
  acceptance refused, three refusal layers that answered alike, and a limiter
  keyed on the address rather than the invitation — plus one configuration
  fault, a beta variable set as `CLIENT_AUTH_SECRE`. All four are recorded in
  [`client-auth.md`](./client-auth.md). After them, a real client accepted, the
  Workroom moved to 1 member / 0 waiting, Studio showed HAS ACCESS, and later
  returns went through the ordinary sign-in — the invitation stays single use.

**Stage C — Reviews.** **Schema, domain, projection and authorization. No
surface, so not usable.** Migration `0006_reviews.sql` is applied and accepted
on beta; `lib/db/reviews.ts` holds the round lifecycle, the notes and the
anchors; `lib/workrooms/review-view.ts` is the only producer of client-visible
Review data; and both worlds have a guarded action layer. There is no client
page, no Studio page and no notification, and nothing renders any of it.

- **Every write goes through one module, and every mutation opens by locking
  the Review row** — the round's serialization point. The order is
  `presentations → presentation_reviews → presentation_review_notes` and is
  never acquired upward; `reopenReview` and `publishPresentation` are the only
  two that reach the first, and both take it before the Review.
- **Publishing ends the round on the version it replaces, inside the publish
  transaction**, and touches nothing inside it: no note resolved, nothing
  copied forward, no round created for the new Revision, and an open round
  never blocks a publish.
- **The lock is proved under real simultaneous transactions**, not sequential
  awaits — ten races, each run in both start orders because the first call
  started reliably wins, which one race proved by going the same way six times
  out of six before it was fixed.
- **A type is not a guard**: the CHECK refuses a root that admits to being the
  studio's, but a studio actor cast into the client's shape would have been
  stored as a client. The domain refuses the actor. Found by a test that
  expected the database to catch it and watched it not.
- **One projection for both worlds, and no database identifier anywhere in
  it.** A note is named by its ordinal, an item by its position; a removed
  note's words leave for nobody, Studio included; a withdrawn round projects as
  null; and a stored anchor outside the vocabulary fails closed. The leak tests
  assert against the whole serialized result rather than named fields, and
  prove the markers were really seeded before asserting they are gone.
- **No `version` reaches a browser**, because the round's row lock already does
  what an optimistic check from a form would have done.
- **Every boundary refusal is the same null** — wrong Workroom, Presentation,
  Revision, note, membership or a withdrawn round.

- **A Revision holds one Review round, ever** — a full `UNIQUE`, not a partial
  index over open rows — and the row cannot be deleted or truncated, because a
  unique constraint somebody can delete their way around is not a rule.
- **Feedback belongs to the exact Revision, proved by the database.** A note
  carries its Revision as well as its Review, and two composite foreign keys
  pivot on it, so a note on Revision 2 **cannot** reference an item from
  Revision 1 even inside one Workroom. Tenancy alone had allowed it.
- **Replies are depth one, enforced in PostgreSQL**, not by the interface: a
  reply's parent must itself be a root. This reverses the no-threads rule, on
  the benchmark evidence the Stage B lock said would be re-argued rather than
  inherited.
- **Removal is a tombstone, not a delete** — the author's own, inside fifteen
  minutes, before any reply, never undone, and the body is returned to no
  surface afterwards, staff included.
- **Corrective, not additive.** It drops the eight columns of `0004`'s
  one-response model, which was free only because the table had never held a
  row — and the migration opens with a guard that refuses to run if it ever
  does. Rehearsed on both paths and compared byte-for-byte against a database
  built from scratch.
- **A CHECK passes when its expression is NULL**, and the first closure
  constraint did exactly that for the row it existed to refuse. Found by a test
  asserting against PostgreSQL rather than by reading the SQL.
- **Both Review surfaces are built.** One `ReviewThread`, four routes, and no
  `if (isStaff)` inside it: Studio renders the `ClientReview` the client does,
  from the same component, with its own stylesheet built from the global tokens
  rather than either world's. A page supplies one sentence and a set of server
  actions, and nothing else.
- **What a surface may draw is a capability sidecar**, computed on the server in
  the same request from the same rows — booleans keyed by a note's ordinal, no
  words and no identifiers. It exists because *did this person write it* and
  *are the fifteen minutes still running* are the two questions a page cannot
  answer for itself. **It is guidance, not security**: a test presses every
  control it withholds and watches the domain refuse each one, then asserts the
  round is byte-identical afterwards.
- **Studio's lifecycle is a separate object with no Review content in it** —
  never requested, open, closed, superseded, withdrawn. A withdrawn round
  projects as null to both worlds, correctly, and Studio still has to tell that
  from one nobody asked for. *Take the request back* disappears permanently the
  moment anybody writes, a comment that was taken back included.
- **The studio may correct and take back its own reply**, which Implementation C
  left out while Studio could not write at all. `claimOwnNote` compares the
  author key, so it reaches a studio reply and never a client's words.
- **One `ConfirmDialog` now serves both worlds.** A modal renders in the top
  layer, outside any token root, so `.dialog` composes Studio's token block onto
  itself. Verified in a real browser inside a Workroom.
- **A pre-existing rendering defect was found by reviewing the rendered page**:
  `.roomMeta` was a `<span>` carrying a `margin-top`, so *Previous versions*
  read `Version 120 Sept, 13:49` at every width. One line of CSS.
- **Manual beta acceptance found the item locator missing, and the cause was
  two position spaces.** A draft's `position` is an ordering key with gaps in
  it; a Revision's items were written densely by array index while the frozen
  snapshot kept the draft's numbers. The client's subject picker sent one and
  `createReviewNote` resolved the other. Reproduced through the real form
  against a real database: picking the fourth block attached the note to the
  fifth, and picking the last block was refused outright. A published Revision
  now numbers its blocks by their place in its own sequence, and `readSnapshot`
  renumbers on the way out so Revisions frozen before the fix read correctly —
  immutable rows read rather than rewritten.
- **A note's block and a note's precision are two fields now.** `subject` says
  which block; `anchor` says where inside it and is absent for all of the
  feedback this build can produce. A block that cannot be named renders as
  `Item N` rather than as nothing.
- **A second test defect fell out of it**: an `RSC: 1` request is answered with
  a 307, so the flight half of the leak tests had been reading a zero-byte body.
  It follows the redirect now and asserts the payload is non-empty before
  searching it.
- **Stage C is not manually accepted on beta, and there are no notifications.**
  Feedback is general or item-level; precise anchors are stored and projected
  but not yet drawn.

**Stage A beta acceptance.** Migration `0004` deployed and applied. `npm run
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

**What Build 005 has still not done**, and none of it is blocked by the above.
These are the gates between beta and production:

- **No production bucket exists**, and none is created until promotion.
- **The sweep is not scheduled.** Until it is, abandoned uploads accumulate.
- **No per-object backup or replication strategy**, which is required before
  Build 005 reaches production — see [`restore-rehearsal.md`](./restore-rehearsal.md).
- **`npm run storage:verify` has not been run in production**, because there is
  nothing there to run it against yet. Beta passing says nothing about a bucket
  that does not exist.
- **`npm run env:check` has not been run against production for Build 005's
  variables.** Beta had `CLIENT_AUTH_SECRE` for a whole round of investigation;
  one command would have found it, and one command is the gate.
- **Stage C Reviews has not been walked by hand on beta.** Everything it claims
  is proved by the automated suites and by a browser driving the real forms
  against a local build; neither is a substitute for the journey. Approvals has
  not begun and is read or written by no code.

The viewer and Stage B were both on this list and are no longer: the viewer was
accepted on beta by hand — image, PDF, MP4 and video seeking — and Stage B's
acceptance is recorded above.

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
