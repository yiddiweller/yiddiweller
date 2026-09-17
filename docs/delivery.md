# Delivery

Files, Presentations, Reviews and Approvals — the four things Build 005 puts
**inside** the Workroom that Build 004 built.

Written before the schema, and reviewed against the situations at the end of
this file before a migration is generated. That order is not ceremony: it is why
Build 004's migration needed no corrections. Where a rule here is marked
**invariant**, PostgreSQL enforces it and no application path can reach around
it.

The container is in [`workrooms.md`](./workrooms.md); client identity and
sessions in [`client-auth.md`](./client-auth.md); the client-facing timeline in
[`activity.md`](./activity.md); the internal record in [`audit.md`](./audit.md);
the business records underneath in [`business-core.md`](./business-core.md).

> **Quiet outside. Powerful inside. Personal everywhere.**

---

## The rule everything else follows

```
An approval names a Revision, never a Presentation.
```

A Presentation is a thing the studio keeps working on. A Revision is what one
person saw at one moment. Attaching a client's decision to the mutable object is
how "approved" quietly comes to mean something nobody agreed to — and in this
product the approval **is** the business record, not a UI state.

Everything below is downstream of that sentence.

---

## The model

```
Client ──▶ Project ──▶ Workroom ──▶ Membership ──▶ Contact ──▶ Client identity
                          │
                          ├──▶ Files                       flat. no folders.
                          │      pending → ready
                          │      visibility: internal | shared
                          │      supersedes ──▶ an earlier File
                          │
                          └──▶ Presentations               mutable draft
                                 │
                                 └──▶ Revisions            IMMUTABLE
                                        ├──▶ Revision items  IMMUTABLE, ordered
                                        │      kind=file ──▶ File
                                        ├──▶ Reviews         feedback
                                        └──▶ Approvals       decision
```

**Delivery objects attach to `workrooms.id`, not to `projects.id`.** The
Workroom is the client-facing container and the authorization boundary; a
Project is the internal record of the work. Hanging a client-visible file off a
Project would put an internal record in the middle of every client read and add
a hop to the authorization chain for nothing. `business-core.md` carried an
older sentence saying these attach to a Project; it was written before Workrooms
existed and is corrected there.

**No member roles.** `workrooms.md` left this open — *"Reviewer, Approver and
the rest are Build 005's problem, if Build 005 actually needs them."* It does
not. Any active member may review and approve; who did it is recorded on the
record. A permissions system for client teams of three people is machinery
serving nobody. Revisit when a client asks, not before.

---

## Routing — decided, and the blueprint is corrected to match

**Client delivery routes are nested under `/workrooms/...`. There are no root
`/files/...` or `/approve/...` routes, and there is no new subdomain.**

```
/workrooms/{roomPublicId}                                 overview
/workrooms/{roomPublicId}/files                           shared files
/workrooms/{roomPublicId}/files/{filePublicId}/download   302 → presigned GET
/workrooms/{roomPublicId}/presentations                   list
/workrooms/{roomPublicId}/presentations/{pubId}           one, latest revision
```

`blueprint.md` reserved `/files/...` and `/approve/...` as **root** namespaces on
`yiddiweller.com`, alongside a bare-slug workroom address (`/avio`). Build 004
did not build that: workrooms shipped at `/workrooms/{26-char opaque id}`, which
is the option `architecture.md` itself described as *"The alternative,
honestly."* The blueprint was never revised to record it, so a locked document
and production disagreed for a whole build. That is now corrected in
`blueprint.md` and `architecture.md` rather than left for the next reader to
trip over.

Three reasons nesting is right, none of them aesthetic:

1. **`middleware.ts` scopes `Cache-Control: private, no-store` and
   `Referrer-Policy: same-origin` to `/workrooms/:path*`.** A root `/files/`
   route falls outside that silently — private bytes with no cache header and
   nothing failing loudly.
2. **`robots.txt` disallows `/workrooms`.** A second private namespace needs its
   own line, and that line was wrong for two builds before it was caught.
3. **Every guard would need a second entry point.** Two doors into one room is
   how the second door gets forgotten.

A file is meaningless outside its Workroom's authorization context, so its
address says so.

**The reserved-slug table is not built and is not needed.** `architecture.md`
said the reserved list *"becomes a database table when workrooms are built"* —
that was true of the bare-slug design. The `/workrooms/` prefix removes the
collision risk entirely, which was the whole argument for the alternative.

---

## Storage — Railway Storage Buckets

**Locked:** a private, S3-compatible Railway Storage Bucket holds file bytes.
Separate buckets **and separate credentials** for beta and production. No public
bucket. **No custom `yiddiweller.com` domain on the bucket, and specifically
never `files.yiddiweller.com`** — which the blueprint's forbidden-subdomain list
already names.

That last one is written down because it is the tidy-looking improvement a
future session will reach for. Presigned URLs live on the bucket's own endpoint.
That is Railway's domain, not ours, and it stays that way.

| | |
| --- | --- |
| Provider | Railway Storage Buckets, S3-compatible |
| Client | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, pointed at the bucket's endpoint |
| Buckets | Separate bucket and credentials for beta and production |
| Public access | None. The bucket is private and no policy grants anonymous GET |
| Abandoned uploads | **Cleaned up by us**, not by the bucket. See *Sweeping abandoned uploads* |

### What the bucket does and does not do — verified

Verified externally against Railway's current documentation. The design below
uses only the left column.

| Supported, and used here | Not supported |
| --- | --- |
| `PutObject`, `GetObject`, `HeadObject`, `DeleteObject` | Bucket **lifecycle configuration** |
| `ListObjects` / `ListObjectsV2` | Object **versioning** |
| `CopyObject` | Object **locks** |
| Presigned URLs | **Server-side encryption** configuration |
| Multipart uploads | |
| Object tagging (available; not needed) | |

Every operation this architecture depends on is in the left column, including
the two the whole upload design rests on: `CopyObject` for the pending →
permanent promotion, and multipart for files above the threshold. **Nothing here
requires anything from the right column**, and three of those four absences
change how something is written rather than whether it works:

- **No lifecycle configuration**, so abandoned uploads are the application's
  job. That is the correction below, and it is the only behavioural change.
- **No object versioning and no object locks**, so *storage provides no
  immutability of its own*. Ours is architectural — a permanent key that is
  never a presigned upload target, never overwritten, and referenced by
  immutable revision rows — and it was never leaning on the bucket. That is
  now load-bearing rather than belt-and-braces, which is worth knowing.
- **No server-side encryption configuration**, so objects are encrypted at rest
  only as the platform encrypts them by default. We do not configure it and do
  not claim more than that.

**Why Railway and not Cloudflare R2.** This was R2 until the provider decision
was revisited. Railway Buckets are S3-compatible, private, support presigned
URLs, and are already inside the platform this application is deployed on — so
adding Cloudflare would mean a second vendor account, a second set of
credentials to rotate and a second place to look when something is wrong, for a
capability Railway now provides. **Fewer moving parts wins when the capability is
equivalent.**

**What that costs, recorded rather than glossed.** R2 was partly chosen because
it sits *outside* Railway, so a future platform move would not also be a data
migration. Railway Buckets give that up: storage is now coupled to the same
vendor as compute and the database. It is a real tradeoff and it was accepted
deliberately. The mitigation is that the coupling is **only an endpoint and a
credential** — see *Provider neutrality* below — so a move is a configuration
change plus a bulk copy, not a rewrite.

**Why not a Railway volume**, which is the other in-platform option and is still
refused:

- A volume attaches to **one service in one region** and blocks running more
  than one instance.
- It puts file bytes **in the application container's filesystem**, which this
  design forbids outright: the container is ephemeral, rebuilt on every deploy,
  and nothing a client paid for should live there.
- It has no presigned-URL story, so every download would stream through the
  Next server — the one thing this architecture is built to avoid.

A bucket has none of those properties. It is object storage reached over an S3
API, not a disk.

### Object storage sits outside the database backup story — for any provider

This was stated as an argument against Railway volumes. It is equally true of a
bucket, including this one, and using it only against the option we rejected
would have been dishonest. It is not a reason to store bytes in PostgreSQL,
where they would bloat every backup and every restore rehearsal. It is a reason
to write down exactly what is and is not protected: see **Durability, stated
plainly** below.

### Provider neutrality

The storage layer is written against **S3, not against Railway.** Module names,
types and functions say `storage`, never the vendor:

```
lib/storage/client.ts     an S3 client built from endpoint + credentials
lib/storage/keys.ts       key construction
lib/storage/presign.ts    presigned GET, PUT, multipart part URLs
```

Nothing above the adapter knows who is holding the bytes. Moving to R2, S3,
Backblaze or MinIO is a different endpoint and a different credential, plus a
bulk copy — which is exactly the property that makes the vendor coupling above
an acceptable cost rather than a trap.

**PostgreSQL stores metadata, relationships, authorization, history and the
integrity values read back from storage. The bucket stores bytes.** A 2 GB video
in a `bytea` column bloats every backup, every PITR window and every restore
rehearsal, and this database is the one part of the system whose recoverability
has been proven.

### Configuration

A Railway bucket exposes five credential values, **verified**:

```
BUCKET   ENDPOINT   REGION   ACCESS_KEY_ID   SECRET_ACCESS_KEY
```

A service reaches them through **Variable References**, so the names the
application reads are chosen when the reference is created. Mapping them to
prefixed, application-facing names keeps the storage adapter readable and keeps
`ACCESS_KEY_ID` from looking like it might be anyone's:

| Application variable | Railway value |
| --- | --- |
| `BUCKET_ENDPOINT` | `ENDPOINT` |
| `BUCKET_NAME` | `BUCKET` |
| `BUCKET_REGION` | `REGION` |
| `BUCKET_ACCESS_KEY_ID` | `ACCESS_KEY_ID` |
| `BUCKET_SECRET_ACCESS_KEY` | `SECRET_ACCESS_KEY` |

**Every one is a Variable Reference. No secret value is ever copied by hand.**
Pasting a key into a second variable creates a copy that has to be rotated twice
and will one day be rotated once — the same class of mistake as a secret in a
build argument. All five are **runtime-only and never build arguments**;
`SITE_ENV` remains the single permitted build argument. `scripts/check-env.mjs`
reports them.

### Beta and production isolation — verify the topology, do not assume it

Beta and production must use **different buckets with different credentials**,
for the reason `BETTER_AUTH_SECRET` is per environment: a beta credential must
never open a production object.

Railway states that **each Railway Environment receives its own isolated bucket
instance and credentials.** If this project's `production` and `beta` are two
Railway Environments, that isolation is automatic and there is nothing to
arrange.

**That has not been checked against this project's actual topology.**
`CLAUDE.md` records two Railway environments, `production` from `main` and
`beta` from `beta`, each with its own PostgreSQL service — which strongly
suggests environments rather than two services in one — but *suggests* is not
*verified*, and the failure mode is silent: one shared bucket across both,
looking exactly like two until a beta test overwrites a production object.

**Stage A must inspect the real project and environment structure before relying
on this**, and the bucket isolation must be demonstrated, not inferred — write an
object from beta, confirm production cannot see it.

## Durability, stated plainly

Three facts, none of them comfortable, all of them true:

1. **The bucket is a separate durability surface from PostgreSQL.** Production
   PostgreSQL has PITR and a rehearsed restore. **The bucket does not
   participate in it.** A database restore returns every file's metadata,
   ownership, revision membership and approval history — and none of its bytes.
   That looks like a successful restore right up until somebody opens a
   presentation.

2. **There are no native bucket snapshots or backups, and this document does not
   claim any.** Railway provides no lifecycle configuration, no object
   versioning and no object locks. Whatever whole-bucket deletion protection the
   platform offers is a guard against deleting the bucket; **it is not per-object
   backup and it is not versioning, and it must never be described as either.**

3. **Historical integrity does not depend on the bucket.** With no versioning and
   no object locks, storage offers no immutability of its own — so ours is
   entirely architectural, and it holds: a permanent key is never a presigned
   upload target, is never overwritten, and is referenced by revision rows that
   PostgreSQL refuses to update or delete. What that architecture cannot defend
   against is **deletion** of an object, by credential compromise or by our own
   mistake. The sweep is built so it cannot be that mistake; a stolen credential
   is not addressed by anything here.

**A per-object backup or replication strategy is therefore an open question, not
a solved one.** It belongs in [`restore-rehearsal.md`](./restore-rehearsal.md),
which now carries it, and it must be answered before Build 005 is promoted —
not before Stage A begins, because Stage A does not yet hold anything a client
paid for.

## Files

Flat. **No folders and no collections in Build 005.** A Workroom is one project,
and the *organised* view of its files is a Presentation — that is what
Presentations are for. Folders would be a second, competing organisation scheme
over tens of files. If a Workroom ever genuinely holds hundreds, a flat table
migrates into a foldered one cleanly; the reverse does not.

| Field | |
| --- | --- |
| `public_id` | 26-char Crockford base32, same generator as Workrooms |
| `display_name` | Client-facing. Editable. What a client sees |
| `original_filename` | Recorded. **Never shown to a client**, never used to build a key or a URL |
| `content_type` | Recorded. **Never trusted for rendering** |
| `byte_size` | Verified against the bucket, not taken from the browser |
| `storage_key` | Permanent, immutable, internal |
| `storage_etag` | The bucket's own value, read by an authenticated HEAD |
| `preview_key` | Optional second object; images only |
| `status` | `pending` → `ready` |
| `visibility` | `internal` \| `shared` |
| `supersedes_file_id` | The File this one replaces |

Visibility is two values, not three and not a matrix. A file is either something
the studio is holding or something the client has been given.

### `original_filename` stays internal

It is where `final_v7_CLIENTNAME_dontsend.pdf` lives. The client sees
`display_name`, which somebody chose on purpose.

---

## Upload: pending, verify, promote

**No file bytes pass through the Railway/Next server, in either direction.**

### The correction this flow exists to make

**A presigned PUT does not enforce a `content-length-range`.** That condition
belongs to S3's browser POST **policy**, which is a different mechanism.
Assuming otherwise would have left the 2 GB ceiling resting on the browser's
good behaviour. Signing `Content-Length` as a signed header binds what the
client *declares*; it is defence in depth, not the guarantee.

This is a property of the S3 API itself, not of any one provider, so it survives
the move from R2 to Railway Buckets unchanged — as does everything else in this
section. The flow below is written against S3 semantics and names no vendor.

**The guarantee is an authenticated HEAD after the bytes land.**

```
1. staff choose a file
2. browser reports name, declared size, declared type
3. server validates the DECLARED values, refuses early if obviously wrong
   → creates a `pending` row
   → issues upload authorization for   pending/{upload_id}
4. bytes go browser → bucket directly
5. browser calls finalize
6. server performs an AUTHENTICATED HEAD on pending/{upload_id}
      actual byte_size == declared size ?
      actual byte_size <= 2 GB ?
      object exists ?
   any answer no  →  finalize FAILS, pending object deleted, row stays pending
7. server-side COPY  pending/{upload_id}  →  w/{workroom}/f/{file}
8. server DELETES the pending object
9. row records verified byte_size and storage_etag, becomes `ready`
```

Nothing is `ready` until step 9. A row that never gets there is an abandoned
upload and is the one thing in Build 005 that may be **hard-deleted** (§Archive).

### Why pending and permanent are different keys — invariant

**An upload never writes to the permanent key.** If the presigned URL pointed at
`w/{workroom}/f/{file}`, then that URL — which lived in a browser, in a network
log, possibly in a crash report — could overwrite the permanent object for as
long as it stayed valid. A File referenced by a decided Revision would be
mutable through a stale link.

So uploads land in `pending/{upload_id}`, and the permanent object is created by
a **server-side copy** the browser never has a URL for. The permanent key is
never the target of any presigned upload, ever, and is therefore not writable by
anything outside our own credentials.

Nothing under `w/` is ever deleted by anything except a deliberate,
guarded action. `pending/` is swept by us — see below.

### Keys

```
pending/{upload_id}                 transient, swept by the application at 24h
w/{workroom_id}/f/{file_id}         permanent, immutable, never overwritten
w/{workroom_id}/f/{file_id}/preview optional image preview
```

Server-generated throughout. No caller-supplied string reaches a key, so path
traversal is not defended against — it is structurally impossible.

### Multipart

**Threshold: 100 MB. Part size: 16 MiB.**

Above 100 MB the browser uses S3 multipart upload against `pending/{upload_id}`:
`CreateMultipartUpload` server-side, a presigned `UploadPart` URL per part,
`CompleteMultipartUpload` server-side. Below it, one presigned PUT.

16 MiB parts put a 2 GB file at 128 parts — far under the 10,000-part limit,
with a failed part costing at most 16 MiB of re-upload. One enormous PUT of a
2 GB file has no resume: a dropped connection at 94% starts again, which is the
difference between a studio that ships video and one that gives up and uses
WeTransfer.

`storage_etag` for a multipart object is not an MD5 of the content — it is
conventionally `{md5-of-part-md5s}-{n}`, and a provider is not obliged to use
that form. It is treated as **an opaque integrity value from the bucket**,
compared only against itself, never computed, parsed or interpreted by us. That
is what keeps it correct across providers.

Multipart upload is **verified as supported**, so the >100 MB path is settled
rather than provisional.

### Stage A is verified on beta

Migration `0004` deployed and applied on Railway beta, and **`npm run
storage:verify` was run inside the real beta app container against the real
Railway Storage Bucket. Every check passed:**

| | |
| --- | --- |
| Presigned PUT | accepted by the provider |
| Authenticated HEAD | real size and a real ETag |
| Server-side `CopyObject` | permanent object created |
| Presigned GET | the correct bytes came back |
| Forced disposition | `attachment` honoured |
| Multipart upload | succeeded |
| Pending object deletion | succeeded |
| Missing object | clean 404 |
| **Unsigned GET** | **refused — the bucket is private** |

That last row is the one a local stub can never answer: an unauthenticated test
double has nothing to refuse with. It is why the verifier exists rather than
being replaced by more unit tests, and it is now answered by the thing that
counts.

**Manual acceptance passed with it.** Studio Files loaded, `unnamed.png`
uploaded, 1.4 MB stored, the default state was `internal`, and Share moved it to
`shared`. Then — after `5f3d206` — the client-safe Preview showed the Files
section, the file, a safe type and size, `Open files →`, and the `file.shared`
line in Activity, with `WorkroomOverview` keeping the Preview and the real
client overview aligned by construction.

**Run the verifier in production too, before Build 005 is promoted.** Nothing
about beta passing says anything about a bucket that does not exist yet.

#### What the automated tests still do not prove

Everything under `npm test` runs against an in-process S3-compatible server that
accepts any signature. That was always the limit, and it has not changed — the
suite proves the flow and the authorization around it, and the *provider* is
proven by the verifier, per environment, by hand. Both are needed and neither
substitutes for the other.

Two things implementation changed, recorded here because the document said
otherwise:

- **`display_name` defaults to the uploaded filename.** There is no better
  starting point and inventing one would be worse — but it means a file shared
  without being renamed shows the client whatever it was called on somebody's
  desktop. The promise this document makes is narrower than it first reads: the
  *recorded* `original_filename` never travels and never follows a rename. The
  name the client sees is the studio's to choose, at share time.
- **The client overview and the staff preview are one component, not two
  copies.** They were two, and Build 005 added a Files section to one of them —
  so a file could be shared, appear in the client's Workroom, and be invisible
  to the person checking their work. Nothing failed; the preview simply showed
  an older product, which is the worst way for a verification surface to be
  wrong. Found by hand on beta. `components/workrooms/WorkroomOverview.tsx` is
  now rendered by both, so there is no second copy to forget, and a test asserts
  the two surfaces list identical sections.

  The one thing that legitimately differs is **how the data is fetched** — the
  preview has no client session and so no membership to scope by. The
  *visibility* rules are shared rather than restated: `sharedFilesInWorkroom`
  and `filesForViewer` both build on one `clientVisible()` predicate, so ready,
  shared and unarchived cannot come to mean two things.
- **A page under `/workrooms` must not set its own title.** The layout sets a
  plain string, which stops the root template propagating, so a page-level
  title renders bare — "Files" rather than "Files — Yiddi Weller". Every client
  page therefore inherits the same generic "Workroom", which is better than the
  alternative anyway: the title now says nothing about the work *and* nothing
  about which page you are on.

### Sweeping abandoned uploads — ours, not the bucket's

**Railway Buckets do not support lifecycle configuration.** An earlier draft of
this document assumed a 24-hour rule under `pending/` would expire abandoned
uploads. It will not, and nothing would have failed loudly — the objects would
simply have accumulated for ever while the document said they were being cleaned
up. Cleanup is the application's job.

A **bounded, idempotent maintenance sweep**:

```
find  workroom_files WHERE status = 'pending' AND created_at < now() - 24h
      ordered oldest first, LIMIT n

for each row:
   1. assert the key starts with `pending/`      ← refuse anything else
   2. DeleteObject                               ← tolerate "not found"
   3. DELETE the database row
```

Five properties, each load-bearing:

- **The object is deleted before the row.** The reverse order loses the key on a
  partial failure, leaving an object nobody can name — an unrecoverable leak. In
  this order a crash between the two leaves the row, the next run finds it, and
  the object delete no-ops.
- **Idempotent.** A missing object is success, not an error. Running the sweep
  twice, or twice concurrently, changes nothing the first run did not already do.
- **It can only ever touch `pending/`.** The prefix is asserted from the row
  before the delete is issued, so a bug elsewhere that wrote a permanent key
  into a `pending` row still cannot delete a real file. `w/` is unreachable from
  this code path by construction, not by intention.
- **Bounded.** A `LIMIT` per run, so it cannot turn into an unbounded delete
  loop against storage or hold a long transaction.
- **Only `pending` rows, only older than 24 hours.** A `ready` row is never a
  candidate, and an upload in progress is never mistaken for an abandoned one.
  `ON DELETE restrict` on `presentation_revision_items.file_id` is the second
  line of defence: a file that any revision references cannot be deleted by
  anything, including this.

**Built as `npm run storage:sweep` (`scripts/sweep-pending.mjs`), and still not
scheduled** — beta passing its storage verification changed nothing about this. It refuses to run without storage configured, rather than deleting
rows whose objects would then be unreachable, and logs counts only — no key, no
filename, no workroom.

The recommended scheduling mechanism is **a separate Railway cron service in the
same environment**, sharing the variable references, running
`npm run storage:sweep` daily. Not an invocation beside the migration: that
couples cleanup to deploy frequency, so a quiet fortnight means no sweep at all,
and a deploy is the worst moment to start deleting things. **Until it is
scheduled, abandoned uploads accumulate** — a cost measured in pennies, and a
fact stated rather than assumed away.

Object tagging is available and is not used. The `pending/` prefix plus the
database row already answer every question the sweep asks, and a tag would be a
second source of truth for the same fact.

### Why there is no browser-computed SHA-256

It was considered and rejected. The browser could hash during upload and report
it, but we cannot verify that claim without streaming the bytes through our own
server — the one thing this design exists to avoid. It would detect corruption
and not tampering, and the uploader is trusted staff, so the threat it defends
against is not in the model. The verified `byte_size` plus the bucket's
`storage_etag`,
both read by our own authenticated HEAD, are facts rather than claims.

### Image previews — included, browser-only

**Locked:** previews are generated **in the browser**, for image formats the
browser can safely decode, and stored as a **separate private object**.

- **No server-side image processing.** No `sharp`, no transform service.
- **No PDF rasterization. No video transcoding.**
- **Unsupported originals remain download-only** — a typed, sized row.
- **SVG is never decoded for a preview and never rendered inline.** An SVG
  served from our origin is stored XSS.

Without this, a phone opening a Workroom downloads a 40 MB original to look at a
thumbnail. With it, one canvas call and roughly 80 KB. The preview is a
convenience, never the artefact: every download serves the original bytes.

**Where it is shown**, added after manual acceptance found the pipeline built
and nothing rendering it — the preview object was generated, stored, authorized
and projected, and no surface consumed it, so a shared image could only be
downloaded:

| Surface | What an image gets |
| --- | --- |
| Client Files page | A framed preview, 16:10, up to 420px, `object-fit: cover` |
| Client Workroom overview | A 40px square hint beside the name, decorative |
| Studio Files list | A 32px square, **internal images included** |

Three rules the shape follows. **A fixed frame, so mixed aspect ratios keep one
rhythm and nothing moves as images load** — `aspect-ratio` reserves the space
before the bytes arrive, which is why no dimensions need storing. **The `src` is
one of our own routes, never a signed URL**, so the storage address reaches
neither the markup nor the address bar; the browser follows the redirect inside
the `<img>`. And **it stays a list**: one column, capped width, no masonry, no
lightbox.

`next/image` is refused here and the reason is in `eslint.config.mjs`. It would
proxy bytes through this server — the one thing this design forbids — and cache
private work to the container's filesystem, and the source expires in sixty
seconds anyway.

**The staff preview image route is separate from the client's**, checking
`currentStaff` and applying no visibility filter, because recognising an
internal image at a glance is most of why a thumbnail earns its place in Studio.

---

## Presentations

A Presentation is **a deliberate delivery moment** — the studio saying *here is
what we have made, please look at it*. Not a slideshow builder, not a folder.

Lifecycle mirrors the Workroom's, which staff already know, plus one thing
Workrooms do not need: **publishing writes a Revision.**

| | |
| --- | --- |
| `title` | Client-facing |
| `intro` | Optional client-safe paragraph; the role `workrooms.summary` plays |
| `status` | `draft` \| `published` \| `unpublished` |
| `current_revision_id` | The Revision a client sees now |
| `version`, `archived_at` | As every editable business record |

**Draft items** are mutable and invisible to clients. Two kinds only: a **file**
reference and a **note** (a caption or short section heading). A presentation of
design work is files with words between them.

**Publishing is deliberate**, exactly as it is for a Workroom. Creating one
exposes nothing.

**Staff preview** renders through the *same* `toClientPresentationView`
projection the client page uses, so the preview cannot drift from the thing it
previews. It issues no client session — staff authority is staff authority, and
there is no "sign in as this client" anywhere in this product.

---

## Revisions — immutable

Publishing freezes the presentation's current contents into a Revision.

```
presentation_revisions        revision_number 1, 2, 3 …
        ├── snapshot          jsonb: the frozen client-safe projection
        ├── content_hash      sha256 over the canonical snapshot
        └── presentation_revision_items   ← ordered, relational, immutable
```

**Both tables are immutable. PostgreSQL refuses `UPDATE` and `DELETE` on both**,
by trigger, in the manner `audit_events` has been protected since Build 003.
Immutability that only the application believes in is not immutability.

### Why relational items exist, and a snapshot alone does not

A JSON snapshot can show what somebody was looking at. It cannot:

- carry a **foreign key**, so nothing stops the File it names being deleted
- support an **archive guard** — "is this File referenced by a decided
  Revision?" is a query, not a JSON scan
- give a **Review** a real target to point at
- **prove which physical file** belonged to a decision

So `presentation_revision_items` is the record of what a Revision contained:
`workroom_id`, `presentation_revision_id`, `position`, `kind`, `file_id` when
`kind = 'file'`, and the **snapshots of what the client was shown** —
`display_name_snapshot`, `caption`, `body`. Snapshots, because renaming a File
afterwards must not silently rewrite what a decided Revision says.

The `snapshot` JSONB stays, as the canonical frozen rendering — the exact bytes
of the client-safe projection at that moment, so "what were they shown" needs no
reconstruction. **Relational items are the integrity record; the snapshot is the
frozen view.** Both, not either.

### The snapshot's one weakness, named

`workroom_activity` guarantees structurally that no internal note can be pasted
into it: there is no column to paste one into. A JSONB snapshot cannot make that
promise. So it is held two ways instead, and this is written down rather than
glossed:

1. The snapshot is written **only** by serialising the return value of
   `toClientPresentationView`. Never assembled by hand, never from an ORM row.
2. A test asserts that no marker seeded into any internal field ever appears in
   any revision row.

That is one level weaker than a structural guarantee and it should be read as
such.

---

## Reviews

**Request → response → resolution. No threads.**

A Review attaches to a **Revision**, optionally narrowing to one **revision
item** within it.

| `status` | |
| --- | --- |
| `requested` | Staff asked. A client cannot open one unprompted in Build 005 |
| `responded` | The client wrote back, once |
| `resolved` | The studio recorded what it did about it |
| `withdrawn` | Staff took the request back before an answer |

### The tradeoff, argued rather than asserted

Threaded replies are what a client will occasionally want, and what will
reliably become chat. Once there are threads there are unread counts, then
notifications, then mentions, then attachments inside replies — and the studio
has built a worse Slack inside its delivery tool. `blueprint.md` places
Communications at Build 007 for a reason.

The cost is real: a client with two separate thoughts gets one field. The
argument for accepting it is that the studio's answer is to make the change and
publish Revision 2 with a fresh review request. The conversation moves the
deliverable forward instead of sprawling underneath it, and anything needing
genuine discussion happens on a call — where it already happens — with the
*outcome* landing in the resolution note.

Adding `review_notes` later is additive. Starting with threads and removing them
is not.

**Reviews block nothing.** A Revision can be approved with an open review, or
reviewed and never approved. Two different acts, two independent records.

---

## Approvals

A **business decision**, recorded once and never edited. Not a status field on a
Presentation, and not an audit event.

It answers, by construction:

| Question | Answered by |
| --- | --- |
| What was approved? | `presentation_revision_id` |
| Which exact version? | The Revision **is** the version |
| Which physical files? | `presentation_revision_items.file_id` |
| Who? | `decided_by_identity_id` + `decided_by_name` snapshot |
| When? | `decided_at` |
| Superseded? | A later Revision of the same Presentation exists |
| Requested, or spontaneous? | `requested_at` / `requested_by` are nullable |
| What were they shown? | The Revision's items and snapshot |

**Declining requires a short reason.** `decline_reason` is `NOT NULL` when
`status = 'declined'`, enforced by CHECK. A decline with no reason is a dead end
for both sides, and the reason is the most useful sentence in the whole record.

### Transitions — invariant, enforced in PostgreSQL

```
requested ──▶ granted     terminal
          ──▶ declined    terminal
          ──▶ withdrawn   terminal
```

**Once granted, declined or withdrawn: no UPDATE, no DELETE.** A `BEFORE UPDATE`
trigger refuses any row whose old status is terminal, and refuses any transition
that is not one of the three above. A `BEFORE DELETE` trigger refuses outright. A
statement-level `BEFORE TRUNCATE` trigger refuses that too — the same three-way
protection `audit_events` carries, for the same reason: business history that can
be truncated is not history.

**A new decision about changed work requires a new Revision.** There is no path
that rewrites a terminal one, and that is the point of the whole design.

**Double approval is impossible** — a partial unique index over
`presentation_revision_id WHERE status IN ('requested','granted','declined')`.
Two tabs pressing Approve produce one approval and one clean refusal, decided by
the database rather than by a read both of them passed. The same mechanism as
`workroom_invitations_one_open_idx`, which has already survived a real race test.

---

## Files are immutable once ready

**A `ready` File is never replaced in place.** Replacement creates a **new File
row and a new object**; the old row gains nothing and the new one records
`supersedes_file_id`.

**If any Revision references a File:**

- it cannot be hard-deleted
- it cannot be archived in a way that breaks that Revision
- its storage key can never be overwritten

The third is structural (§Upload): the permanent key is never a presigned upload
target. The first two are guards in the domain layer plus `ON DELETE restrict` on
`presentation_revision_items.file_id`.

`storage_key`, `storage_etag` and `original_filename` are **never exposed to a
client**, in any projection, in any response.

---

## A decided Revision stays reachable — invariant

Once a Revision carries a terminal approval decision, it is part of the
Workroom's business history.

**Staff may:**

- create and publish a newer Revision
- see the older Revision marked *superseded* by context — computed from the
  existence of a later Revision, never stored as mutable state on the old row

**Staff may not:**

- mutate the decided Revision or any of its items
- replace the files it references
- erase, edit or withdraw the approval
- unpublish or archive the Presentation in a way that makes the decided
  Revision disappear

The last one has a precise meaning. **Unpublishing a Presentation that has a
decided Revision is refused**, naming the decision — the same shape as the
Build 003 refusal that blocks archiving a Project whose Workroom is open, and
for the same reason: it would take something away from a client without anyone
deciding to. Unpublishing before any decision is ordinary and allowed.

**Archiving a Presentation with a decided Revision is refused** for staff, and
**archiving a Workroom holding one is refused** as well. Archive is the studio
tidying up; it is not a way to make a signature disappear.

---

## Composite-FK tenancy — invariant

Every delivery object belongs to exactly one Workroom, and PostgreSQL enforces
the chain rather than trusting that every future code path remembers to.

```
workroom_files              UNIQUE (workroom_id, id)
presentations               UNIQUE (workroom_id, id)
presentation_revisions      UNIQUE (workroom_id, id)
presentation_revision_items UNIQUE (workroom_id, id)

presentation_items          FK (workroom_id, presentation_id)          →  presentations
presentation_items          FK (workroom_id, file_id)                  →  workroom_files
presentation_revisions      FK (workroom_id, presentation_id)          →  presentations
presentation_revision_items FK (workroom_id, presentation_revision_id) →  presentation_revisions
presentation_revision_items FK (workroom_id, file_id)                  →  workroom_files
presentation_reviews        FK (workroom_id, presentation_revision_id) →  presentation_revisions
presentation_reviews        FK (workroom_id, revision_item_id)         →  presentation_revision_items
presentation_approvals      FK (workroom_id, presentation_revision_id) →  presentation_revisions
```

A Revision in Workroom A cannot reference a File in Workroom B. Not "should
not" — cannot. The insert fails.

### This is not the `client_id` mistake

`workrooms.md` rejects a `client_id` column on `workrooms` because *"it would be
a second copy of `projects.client_id` that could drift from it."* The word doing
the work is **drift**.

`workroom_id` on a revision item is also a second copy — but one the composite
foreign key makes it **impossible** to diverge: a row whose `workroom_id`
disagrees with its parent's is rejected by PostgreSQL. Redundant-and-
unconstrained is a liability. Redundant-and-constrained is an invariant. The
distinction is the whole difference, and it is recorded here so the next reader
does not mistake one for the other.

---

## Client-safe projections

`lib/workrooms/delivery-view.ts`, following `view.ts` exactly: **whitelists, not
filters.** No ORM row is ever spread into a client component.

```
ClientFile          { id, name, kind, size, previewPath?, downloadPath }
ClientPresentation  { id, title, intro, publishedAt, revision, items[] }
ClientRevisionItem  { id, kind, caption, body?, file? }
ClientReview        { id, status, requestedAt, response?, resolution?, resolvedAt? }
ClientApproval      { id, status, requestedAt, decidedAt?, decidedBy?, declineReason? }
```

**Deliberately absent, and never fetched on a client request:** `storage_key`,
`preview_key`, `storage_etag`, `original_filename`, raw `content_type` (a coarse
`kind` of `image | pdf | video | document | other` instead), raw byte counts
(formatted server-side), `uploaded_by`, every internal id, every `internal` file,
every draft Presentation, every draft item, every `notes` field anywhere, every
`audit_events` row, and every other Workroom's anything.

Adding a field to a client surface means adding it here first, deliberately, in
review.

---

## Activity vocabulary

Seven additions, keeping the shape exactly: a fixed `kind`, an `actor_label`, a
`subject` that is one safe label. **There is no `metadata` column and there is
not going to be one.**

| `kind` | Reads as | Written when |
| --- | --- | --- |
| `file.shared` | *Brand guidelines was shared* | A File's visibility becomes `shared` |
| `presentation.published` | *Identity concepts is ready* | First publication |
| `presentation.revised` | *Identity concepts was updated* | A later Revision is published |
| `review.requested` | *Your thoughts were requested on Identity concepts* | Staff request a review |
| `review.received` | *Ana Alder sent feedback* | A client responds |
| `approval.requested` | *Approval was requested for Identity concepts* | Staff request approval |
| `approval.decided` | *Ana Alder approved Identity concepts* | A client grants or declines |

`subject` carries a File's `display_name` or a Presentation's `title` — both
already client-facing fields, never internal ones.

**`approval.decided` is one kind, not two.** The verb comes from the approval
record the reader already holds; a decline is not a separate species of event.
`architecture.md` gave `approval.submitted` as an illustration; "decided"
describes what the business record now holds rather than which button was
pressed, and still satisfies `noun.verb_past_tense`.

**`presentation.revised` is separate from `presentation.published`**, because
"we updated this" and "here is something new" are different messages, and
collapsing them makes a revision look like a fresh deliverable.

**`presentation.viewed` is not built — not as Activity, not as Audit.** It was
considered. A studio wants to know whether work was looked at, but
`workroom_activity` is *the client's* timeline, so such a row shows a client a
log of their own reading, which reads as surveillance in a product whose
principle is *personal everywhere*. Not in Build 005, and not by accident.

### Noise

Sharing twenty files at once writes twenty rows into a timeline designed to be
calm. **Collapse consecutive same-kind events in the reader** — *"6 files were
shared"* — while the table keeps one row per file and stays honest. Collapse in
the projection, never in the table.

---

## Audit

Internal, append-only, Owner-readable. Written in the same transaction as the
business change and the activity row, from the same event, with different
content.

New entity types: `workroom_file`, `presentation`, `presentation_revision`,
`presentation_review`, `presentation_approval`.

New actions:

```
file.uploaded  file.renamed  file.shared  file.unshared  file.replaced
file.archived  file.restored
presentation.created  presentation.updated  presentation.published
presentation.unpublished  presentation.archived  presentation.restored
review.requested  review.responded  review.resolved  review.withdrawn
approval.requested  approval.granted  approval.declined  approval.withdrawn
```

Client-caused actions — `review.responded`, `approval.granted`,
`approval.declined` — are written with `actor_type = 'client_user'` and
`client_actor_id` set. The `audit_events_actor_shape_check` makes it
structurally impossible to file a client under the staff foreign key.

**`metadata` carries field names and ids only, never values.**
`{ "fields": ["display_name"] }`, `{ "revision": 3 }`. Never a caption, never a
review body, never a filename, never a storage key, never a decline reason,
never a presigned URL. `entity_label` carries a name or a title and nothing else.

**Approval history lives in `presentation_approvals`, not here.** Audit records
*that* an approval happened; the approval record *is* the business fact.
`audit.md` is explicit that audit "records that something changed, never what it
now says" — and an approval is precisely a thing whose content matters.

---

## Archive, and the one thing that may be deleted

**Nothing that became part of the Workroom is ever deleted through the
interface.** Archive and restore, Owner-only, refused where it would leave the
data nonsensical — the business-core rule, unchanged.

| Object | Archive | Hard delete |
| --- | --- | --- |
| File, `pending` | n/a | **Yes.** It never became part of the Workroom |
| File, `ready`, unreferenced | Owner | No |
| File, `ready`, in any Revision | **Refused**, naming the Revision | No |
| Draft Presentation | Owner | No |
| Presentation with any Revision | Owner | No |
| Presentation with a decided Revision | **Refused**, naming the decision | No |
| Revision, revision item | Never. Immutable | Never |
| Review | Follows its Presentation | No |
| Approval | Never | Never |

The abandoned upload is the whole of the delete surface: a `pending` row whose
bytes never arrived or never verified, plus its `pending/` object, both removed
by the application's own bounded, idempotent sweep — the bucket has no lifecycle
configuration and expires nothing on our behalf. A file that was presented and
approved and a file that was never really uploaded are not the same kind of
thing, and the schema says so.

---

## Notifications

**Publishing never implicitly sends client email.** *Publish* and *Publish &
notify* are two separate, explicit actions. A studio that emails on every save
teaches clients to ignore its emails.

| Trigger | To | Automatic? |
| --- | --- | --- |
| Publish & notify | Active members | **No** — a distinct button |
| Request review | Active members | No — the request is the action |
| Request approval | Active members | No — same |
| Review answered | `CONTACT_EMAIL` | Yes. Rare and consequential |
| Approval decided | `CONTACT_EMAIL` | Yes. Rare and consequential |

Everything else — a file shared, a Presentation revised, a review resolved —
appears in Activity only.

**Emails link to the Workroom, never to a file, and never carry a presigned
URL.** A presigned URL in an inbox is a credential in an inbox. Delivery
failures are logged and never change what staff see, and the address is
redacted, as `lib/auth-delivery.ts` established.

No digests, no preferences, no notification centre, no unsubscribe machinery.
These are transactional messages to people who were deliberately invited.

---

## Authorization

Enforced server-side in the domain module, re-checked in every server action.
**Never by hiding a button.**

| | Owner | Member | Client member | Client non-member | Anonymous |
| --- | --- | --- | --- | --- | --- |
| Upload, rename, replace file | ✓ | ✓ | — | — | — |
| See / download **internal** file | ✓ | ✓ | — | — | — |
| Set file visibility | ✓ | ✓ | — | — | — |
| See / download **shared** file | ✓ | ✓ | ✓ | — | — |
| Archive / restore file | ✓ | — | — | — | — |
| Create, edit, reorder draft | ✓ | ✓ | — | — | — |
| See **draft** Presentation | ✓ | ✓ | **—** | — | — |
| Preview as client | ✓ | ✓ | — | — | — |
| Publish / unpublish | ✓ | ✓ | — | — | — |
| See **published** Presentation | ✓ | ✓ | ✓ | — | — |
| Archive / restore Presentation | ✓ | — | — | — | — |
| Request review | ✓ | ✓ | — | — | — |
| **Respond to review** | — | — | **✓** | — | — |
| Resolve / withdraw review | ✓ | ✓ | — | — | — |
| Request approval | ✓ | ✓ | — | — | — |
| **Grant / decline approval** | — | — | **✓** | — | — |
| Withdraw approval request | ✓ | ✓ | — | — | — |
| See archived delivery content | ✓ | ✓ read-only | — | — | — |

Three rows deserve naming.

**Staff cannot approve.** An approval is the client's decision; a studio able to
record one on their behalf has built a forgery tool.

**Staff cannot respond to a review.** The resolution note is the studio's voice;
the response is the client's.

**Archive is Owner-only**, matching every other archive in the business core.

Every client-facing read goes through **one query** that joins
`workroom_members.status = 'active'`, `workrooms.status = 'published'` and
`workrooms.archived_at IS NULL` — the `workroomForViewer` pattern. Membership is
read from the database on every request and never from the session, so
revocation takes effect on the next click.

**The guard is called inside the component that reads, before it reads**, and
there is no `loading.tsx` anywhere under `/workrooms` or `/studio`. A Suspense
boundary above a guarded page turns a refusal into a 200. Measured; see
`studio.md`.

---

## Security

| Threat | Defence |
| --- | --- |
| Guessed file id | 26-char opaque public id **and** a membership-joined query |
| Guessed storage key | Keys never exposed, never derived from input; bucket has no public access |
| Signed URL leakage | 60-second TTL, minted per request, never in HTML, never in email, never logged |
| Expired signed URL | The client retries through the authorized route, which re-checks membership |
| **Old upload URL reused after finalize** | It points at `pending/`, which no longer exists and is not the permanent key. It can never write to `w/` |
| Revoked membership | Membership read per request; next download is a 404 |
| Unpublished Presentation | `status = 'published'` is in the query, not a filter afterwards |
| Cross-tenant anything | Composite foreign keys. The database refuses it |
| Forged approval | Requires an active client session **and** membership **and** the Revision resolving to that Workroom |
| Double approval | Partial unique index |
| Stale approval | Approvals anchor to Revisions; a new Revision cannot inherit an old decision |
| Rewritten approval | Terminal rows refuse UPDATE, DELETE and TRUNCATE, by trigger |
| File replaced after approval | Permanent keys are never upload targets; replacement creates a new File |
| Archived content | `archived_at IS NULL` in every client query |
| Metadata / RSC leak | Static titles on every new route — `"Presentation"`, never the title. Whole-response leak tests |
| Filename injection | Disposition forced at presign time: sanitised ASCII name plus RFC 5987 `filename*` |
| Malicious MIME | `content_type` recorded, **never trusted for rendering**. Everything downloads as an attachment |
| Uploaded SVG / HTML | Never rendered inline, never previewed. An SVG from our origin is stored XSS |
| Oversize upload | Verified by authenticated HEAD at finalize, not by a presign condition |
| Path traversal | Structurally impossible — no caller string reaches a key |
| Sweep deleting a real file | It only ever reads `pending` rows older than 24 hours and asserts the `pending/` prefix before issuing a delete. `ON DELETE restrict` on `presentation_revision_items.file_id` is the second line |
| **Object deleted by a stolen bucket credential** | **Not defended against here.** Storage offers no versioning and no object locks, so a valid credential can delete an object. Immutability protects against overwrite and rewrite, not deletion — see *Durability* |

**Malware scanning is out of scope, and the boundary is stated.** Files move
studio → client inside an invited relationship, and nothing is rendered inline
or executed. The real exposure would be *client* uploads, which Build 005 does
not have. **If clients ever upload, scanning becomes a prerequisite, not an
enhancement.**

### Limits

| | |
| --- | --- |
| Single file | **2 GB**, verified after upload |
| Workroom | **50 GB soft threshold — a warning to staff, never a wall** |
| Multipart above | 100 MB, 16 MiB parts |
| Files per Presentation | 100 |

**Type policy is an allowlist for *rendering*, not for *accepting*.** A studio's
files are unpredictable — `.sketch`, `.fig`, `.ai`, `.indd`, `.psd`, `.zip`,
`.mov`, `.aep` — and refusing an unfamiliar extension is how a tool becomes
useless on a Tuesday.

- **Accept almost anything.** Recorded, downloadable.
- **Render inline only** `image/jpeg|png|webp|gif|avif` and `video/mp4|webm`.
- **Refuse outright** only the genuinely hostile: `.exe`, `.dll`, `.bat`,
  `.cmd`, `.sh`, `.msi`, `.app`, `.scr`, and anything declaring `text/html`.
- **`image/svg+xml` is accepted, never rendered inline, never previewed.**

**No Presentation ZIP download in Build 005.** It would mean server-side
archiving of files that otherwise never touch our process, which is the one
thing this storage design avoids.

---

## Migration shape

One migration, `0004_delivery.sql`, generated then extended by hand as `0003`
was. **Additive throughout.** No column is dropped, renamed or retyped anywhere
in Builds 001–004.

- Six `CREATE TABLE`, their indexes and composite unique keys
- `bump_version()` on the versioned tables; `set_updated_at()` on the rest
- Append-only triggers on `presentation_revisions` and
  `presentation_revision_items`
- Transition + immutability triggers on `presentation_approvals`, including
  `BEFORE TRUNCATE`
- Two CHECK replacements

**Operations that take a lock, called out because they must be:**

| Statement | Lock | Cost |
| --- | --- | --- |
| Replace `audit_events_entity_type_check` | ACCESS EXCLUSIVE | Full scan of `audit_events`. Small now, and **grows for ever** — the table is append-only. Measure before every future widening |
| Replace `workroom_activity_kind_check` | ACCESS EXCLUSIVE | Full scan of `workroom_activity`. Small |
| `CREATE TABLE`, `CREATE INDEX` on empty tables | Trivial | — |

PostgreSQL has no way to widen a CHECK, so both are `DROP CONSTRAINT` then
`ADD CONSTRAINT` — the pattern `0003` used and documented.

**Build 004 code tolerates the Build 005 schema.** Everything is a new table or
a widened constraint; no existing insert becomes invalid. A code rollback
without a schema rollback is safe — the property Build 004 proved by direct test
and Build 005 must prove the same way.

**Rehearsal before promotion:** rebuild a Build 004-shaped database with
realistic volumes, apply `0004`, assert row-for-row data identity, diff
`pg_dump --schema-only` against a from-scratch build to zero, then run the
**full suite against the migrated database**.

### Review uniqueness and NULL semantics

An open review may be revision-level (`revision_item_id IS NULL`) or item-level.
A conventional unique index treats NULLs as **distinct**, so a single index on
`(presentation_revision_id, revision_item_id)` would permit unlimited
revision-level reviews — the exact case it was meant to prevent.

**Two partial unique indexes, not one:**

```sql
CREATE UNIQUE INDEX presentation_reviews_open_revision_idx
  ON presentation_reviews (presentation_revision_id)
  WHERE revision_item_id IS NULL AND status IN ('requested','responded');

CREATE UNIQUE INDEX presentation_reviews_open_item_idx
  ON presentation_reviews (presentation_revision_id, revision_item_id)
  WHERE revision_item_id IS NOT NULL AND status IN ('requested','responded');
```

PostgreSQL 16 also offers `NULLS NOT DISTINCT`, which would work. Two partial
indexes are chosen because they say what they mean at the point of definition
and do not depend on a server-version feature flag being remembered.

**This is tested directly at the PostgreSQL level** — two revision-level review
inserts must raise — rather than through the domain layer, which would pass for
the wrong reason.

---

## Reviewed against real situations

| Situation | How the model holds it |
| --- | --- |
| **Staff edit after approval** | The draft changes; the decided Revision does not. Its items and snapshot are immutable and the database refuses UPDATE. Publishing creates Revision N+1 with no approval on it |
| **Client approves, then asks for a change** | The approval stands — it was true when made. The change produces a new Revision and, if wanted, a new approval request. Nothing rewrites the first decision |
| **File replaced during an open review** | Replacement creates a **new** File. The Revision under review still points at the original, so the client's feedback keeps its subject. The new File reaches the client only in a later Revision |
| **Member revoked with an open approval request** | The request stays; the person cannot reach it. Another active member may decide. If nobody can, the request sits unanswered — visibly, which is correct. Revocation never silently resolves a decision |
| **Presentation unpublished before any decision** | Ordinary and allowed. The client stops seeing it; Revisions remain |
| **Unpublish attempted after a terminal decision** | **Refused**, naming the decision. Taking a decided deliverable away from a client is not a side effect of tidying |
| **Archive attempted on a File inside a Revision** | **Refused**, naming the Revision. `ON DELETE restrict` blocks the delete; the guard blocks the archive |
| **Double approval** | Partial unique index. One approval, one clean refusal, decided by the database |
| **Double publish** | Unique `(presentation_id, revision_number)`. Two presses produce two distinct numbers or one refusal — never a duplicate number, never a lost Revision |
| **Abandoned upload** | Row stays `pending` and never appears anywhere. After 24 hours the application's sweep deletes the `pending/` object, then the row — that order, so a partial failure leaves a retryable row rather than an unnameable object. The only hard-deletable thing here |
| **Sweep runs twice, or crashes halfway** | Idempotent. A missing object is success; a surviving row is found again next run. It asserts the `pending/` prefix before every delete, so it cannot reach a permanent object even if a row were wrong |
| **Oversize upload** | Declared size refused early; actual size caught by authenticated HEAD at finalize. Finalize fails, pending object is deleted, row never becomes `ready` |
| **Cross-Workroom file reference** | Composite foreign key. The insert fails in PostgreSQL |
| **Old upload URL reused after finalization** | It targets `pending/{upload_id}`, which was deleted and was never the permanent key. The permanent object is not writable by any presigned URL that has ever existed |
| **Client with two Workrooms** | Files and Presentations are per Workroom. Nothing joins across, and the composite keys make it impossible to try |
| **Contact archived while holding a decided approval** | Already refused by Build 004's guard — a Contact with live access cannot be archived. The approval keeps `decided_by_name` as a snapshot regardless |
| **A Revision's File is also shared directly** | Fine. One File, two places. Visibility is the File's; the Revision carries its own snapshot of the name |

---

## What Build 005 is not

Chat. Slack-style comments. Threaded review replies. Client uploads. Folders or
collections. Server-side media processing. PDF rasterization. Video transcoding.
Presentation ZIP downloads. Workroom member roles. `presentation.viewed`
tracking. A notification centre. Public file sharing. External anonymous
approvals. Per-file roles. A Dropbox replacement. A DAM. Invoicing, payments,
contracts or e-signatures — those are Build 006. Inbound email — Build 007.

Each of these was considered against the blueprint and excluded on purpose, not
forgotten.
