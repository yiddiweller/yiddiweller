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
/workrooms/{roomPublicId}/files/{filePublicId}            the viewer
/workrooms/{roomPublicId}/files/{filePublicId}/view       302 → presigned inline GET
/workrooms/{roomPublicId}/files/{filePublicId}/download   302 → presigned attachment GET
/workrooms/{roomPublicId}/files/{filePublicId}/preview    302 → presigned thumbnail GET
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
the studio is holding or something the client has been given. **A Presentation cannot
show a file the client has not been given**: publishing shares what it
references, which is why two values stay sufficient once Presentations exist.

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

### The viewer — one component, one decision, five outcomes

**Locked:** the pattern is the one every review platform converged on, for the
same reason they converged on it. **Store almost anything. Preview what the
browser can safely render. Always keep a separate download of the original.**
A file the browser cannot render is not a failure to apologise for — it is a
polished card and a download, which is what a PSD honestly looks like.

**One decision, in one place.** `viewerKind()` in `lib/storage/policy.ts` maps a
content type to exactly one of five outcomes. Nothing else in the codebase
decides how a file is rendered, and nothing accepts a hint from the request:

| Outcome | Content types | How it renders | Original |
| --- | --- | --- | --- |
| `image` | `image/jpeg`, `png`, `webp`, `gif`, `avif` | `<img>`, `object-fit: contain` | Download |
| `pdf` | `application/pdf` | `<iframe>`, the browser's own viewer | Download |
| `video` | `video/mp4`, `webm`, `ogg` | `<video controls preload="metadata">` | Download |
| `audio` | `audio/mpeg`, `mp4`, `x-m4a`, `aac`, `wav`, `ogg`, `webm`, `flac` | `<audio controls preload="metadata">` | Download |
| `download` | **everything else**, SVG included | A typed, sized card | Download |

**The list is exact matches, never prefixes, and that is the whole security
argument.** `fileKind()` — the human label — does use prefixes, and still calls
an SVG an image, because that is what it is. `viewerKind()` does not, because a
prefix rule on `image/` would admit `image/svg+xml`, and an SVG served from our
own origin is stored XSS: script, `<foreignObject>`, a fetch carrying the
client's session cookie. **Raw SVG is never put in an `<iframe>`, an `<img>`, an
`<object>` or an `<embed>`, and is never decoded for a preview.** It is a
download card, deliberately, and a test asserts that every route refuses to
serve it inline rather than trusting the UI not to ask.

**`audio/x-m4a` is on the list because beta needed it.** An iPhone upload of
*Schick's Take Home Foods.m4a* read *audio · 70 KB* in the Files list — the
label's `audio/` prefix — and rendered as the download card, because the exact
list had `audio/mp4` and not `audio/x-m4a`, which is what Safari and Chromium
declare for an `.m4a` (the upload records the browser's own `file.type`;
Chromium's was measured, and the beta symptom is exactly an `audio/*` type
missing from this list). It is the same MPEG-4 audio as `audio/mp4`, added by
exact name; `audio/m4a`, which nothing observed emits, is not. A test asserts
that every audio type the label names and a browser plays is also a viewer.

**A Revision published before a type is added keeps its download card.** Each
Revision freezes the `viewer` its files had at publication, and that frozen
value is what renders and what anchors are judged against — see *F1* below. The
Files pages read the policy live and show the player at once; a Presentation
shows it from the next Revision published after the change.

**Nothing the uploader controls can choose inline rendering.** The stored
content type is the only input, the map is closed, and the view route refuses
anything `viewable()` rejects before it signs a URL — so an unlisted type has no
inline address at all, not merely no button pointing at one.

**One component renders all five.** `components/workrooms/FileViewer.tsx`
switches on the kind and is used by both the client's viewer page and the
staff's, so the two cannot drift — the same structural fix the Workroom overview
needed when the staff Preview silently fell a feature behind. There is no
per-type page and no per-type layout.

**Two routes per file, and they are different promises.**

| Route | Disposition | TTL | Refuses |
| --- | --- | --- | --- |
| `…/files/{id}/view` | `inline` + the stored content type | 15 minutes | anything not `viewable()` |
| `…/files/{id}/download` | `attachment` + a sanitised filename | 60 seconds | nothing — every file downloads |

**The fifteen minutes is the finding, not an oversight.** Viewing media is a
session, not a fetch: seeking in a video issues a fresh ranged request against
the same signed URL minutes after the page loaded, and a sixty-second URL makes
the scrubber stop working partway through. The exposure is bounded the same way
the download is — a URL for one object, expiring, never permanent, never a
bucket credential — and the bytes are served by the bucket, so a large original
never crosses this server. That constraint is what sets the number: the
alternative to a longer TTL is proxying media through Next, which this
architecture forbids outright.

**Full view never crops.** `object-fit: contain` on a bounded frame, because a
client checking a logo's margins needs the whole artwork, not a pleasing square.
The 16:10 `cover` frame stays on the *list*, where a consistent rhythm matters
more than completeness. Nothing autoplays, `preload="metadata"` everywhere, and
no surprise audio.

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

**Two kinds is confirmed sufficient, re-checked against the benchmark.** A file
item carries an optional `caption`; a note carries a required `body` and an
optional `caption` that reads as its heading. That composes every structure the
research showed mattering — an opening paragraph, a section break, a caption
under a visual — without becoming a page builder. The one shape it cannot
express is a heading with nothing beneath it, and a section break with no words
under it is decoration rather than a requirement. A third kind is refused until
something real needs one.

**Publishing is deliberate**, exactly as it is for a Workroom. Creating one
exposes nothing.

**Staff preview** renders through the *same* `toClientPresentationView`
projection **and the same `PresentationView` component** the client page uses,
so the preview cannot drift from the thing it previews. It issues no client
session — staff authority is staff authority, and there is no "sign in as this
client" anywhere in this product.

**Preview and the client's current view are two different things, and the
interface says which is which.** `/presentations/{id}/preview` renders *the
draft, as it would publish* — labelled as a draft, and for a published
Presentation it is deliberately **not** what the client currently sees. What the
client sees is the current Revision, and staff read that in revision history.
Both render through the one component. Conflating them is how a studio publishes
something it never looked at.

### Publishing shares — the rule that keeps history honest

**Publishing a Revision sets `visibility = 'shared'` on every File it
references**, in the same transaction, before any revision row is written.
Staff are shown exactly which files that is before confirming, and each one
writes its ordinary `file.shared` activity row.

This is not a convenience. It is what makes **one sentence true everywhere,
including inside a Revision published two years ago**: *a client may only ever
see a `ready`, `shared`, unarchived File.* Stage A's `clientVisible()` predicate
is the only authorization a file byte ever passes through, and Stage B does not
widen it, does not add a union, and does not add a second route that reaches a
file some other way.

The alternative was to make a published Revision its own grant — letting a
client reach an `internal` file *through* a Presentation. It was rejected: it
would make `internal` stop meaning "the client cannot see this", split file
authorization across two predicates that must agree for ever, and put the
proof that they agree in a test rather than in the database.

**And the reverse is refused.** A File referenced by a Revision of a
Presentation that is currently `published` and unarchived **cannot be
unshared** — refused, naming the Presentation, the same shape as the Build 003
refusal that blocks archiving a Project whose Workroom is open. Without it,
"stop sharing" silently breaks every historical Revision that shows the file,
which is precisely the contradiction between historical integrity and current
authorization that must not be allowed to arise.

Two guards, two different jobs, and they are deliberately not the same
condition:

| Act | Guard | Because |
| --- | --- | --- |
| Unshare a file | Refused **while** a `published`, unarchived Presentation has a Revision naming it | Sharing is a live authorization state. Unpublish the Presentation and it is released |
| Archive a file | Refused **while any** Revision names it, unconditionally | History must not lose its subject, whatever the Presentation's status is today |

**Retracting what a client was shown is `unpublish`, never `unshare`.** One is
the deliberate act with its own refusal when a decided Revision exists; the
other is library housekeeping. A studio that retracts by unsharing has changed
history by tidying up.

**Only a `ready` File may be added to a draft item or a Revision.** A `pending`
row is a reservation whose bytes may never arrive, and `presentation_items`
references files `ON DELETE restrict` — so a pending file inside a draft would
make Stage A's cleanup sweep fail on that row rather than skip it. Enforced in
the domain, because a CHECK cannot read another table.

---

### Routes belong to the surface, not to the work

Manual beta acceptance found a real defect, and it was hiding a wider one.

Studio Preview rendered a draft's images through the **client's** file routes.
Those correctly require `ready`, `shared`, unarchived and active membership — so
an internal file in a draft rendered as a broken image, and the only ways to
"fix" that would have been to share the file early or to loosen client
authorization. Both are wrong.

The wider half: **a published Revision was broken for staff too.** Every file in
one is shared, so the client's routes resolve — for a client. A Studio session on
a `/workrooms/...` route is sent to the client sign-in exactly as a stranger is,
because that is the isolation working. Staff could not fetch their own Workroom's
files from a Studio page.

**The cause was that paths were content.** `toClientFile` baked the client's
route prefix into the projection, and publishing froze those paths into the
Revision snapshot. A surface had no say in where bytes came from, and the content
hash quietly depended on our URL scheme — so changing a route would have altered
the hash of work published a year earlier.

**Locked: a Revision stores what was delivered, and each surface supplies its own
routes.**

```
PresentedFile   { id, name, kind, viewer, size, hasPreview }   stored, hashed
FileBase        (filePublicId) => string                        per surface
withPaths(file, base) -> ClientFile                             at render time
```

| Surface | Base | Requires |
| --- | --- | --- |
| Client presentation, current and historical | `/workrooms/{room}/files/{id}` | active membership, published unarchived Workroom, `ready` + `shared` + unarchived |
| Studio preview, and Studio's view of a published version | `/studio/workrooms/{workroomId}/files/{id}` | staff, and the file's **own** Workroom in the path. **No visibility filter** — looking at an internal file is what internal means |

Nothing was weakened to achieve it. `clientVisible()` is untouched, the staff
routes are the ones Stage A already shipped, an SVG is refused inline on both,
and a staff route still answers 404 for a file belonging to another Workroom.
**One `PresentationView` and one `FileViewer` render all three surfaces** — the
data differs by one function, the markup not at all.

**Revisions published before this are read, not rewritten.** They are immutable,
correctly, and they already carry each file's opaque public id; the reader
rebuilds routes from that and infers `hasPreview` from the old `previewPath`.
Nothing about what a client was shown changes, and no stored hash moves.

**Retested by hand on beta, and it passes.** A draft holding a `ready`
**internal** image renders that image correctly in Studio Preview; the File is
still `internal` afterwards, because Preview reads it as staff rather than
sharing it early; and one `PresentationView` over one `FileViewer` still renders
the client page, the historical Revision and the Preview. Nothing about client
authorization moved to achieve it.

---

### The publish transaction — what actually ships

One transaction, in `lib/db/presentations.ts`, and every refusal inside it is
**raised as a throw rather than returned**. That is not style: returning an
`Outcome` from a transaction callback commits it, which is right for a single
guarded UPDATE and wrong for something that writes to five tables.

```
SELECT … FOR UPDATE on the Presentation      serialises concurrent publishes
re-read the draft under the lock             what is there now, not at render time
validate every file: workroom, ready, unarchived
share every internal file it references      + file.shared activity and audit each
project → canonical JSON → SHA-256
allocate revision_number under the lock
INSERT presentation_revisions                immutable from this moment
INSERT presentation_revision_items           ordered, immutable
UPDATE presentations … WHERE version = ?     the optimistic gate, deliberately last
presentation.published | presentation.revised
audit presentation.published
```

**The version check is the last write on purpose.** A publish that lost a race
has by then shared files, written activity and inserted two immutable tables —
so the gate has to be somewhere a failure unwinds all of it, and the last
statement of the transaction is exactly that place. A test forces the *final*
statement to fail and asserts that nothing survives: no half-shared file, no
orphan Revision, no activity for a publication that did not happen, and a
`current_revision_id` still null. Then the same Presentation publishes cleanly.

**Revision numbers are never allocated by reading a MAX and hoping.** Three
layers, all in the database: the row lock serialises publishes of this
Presentation, the optimistic `version` refuses the loser cleanly, and
`UNIQUE (presentation_id, revision_number)` is the last line if both were ever
wrong. Two simultaneous publishes produce one Revision, one `conflict`, and one
`file.shared` row — measured, not assumed.

**The draft is one document, so it carries one version.** Retitling it,
rewording a note and reordering it all pass the Presentation's `version` and all
refuse a stale writer. Per-item versions would let two people reorder the same
list at once and both appear to win.

**Reordering exchanges two keys that already exist.** A draft's `position` is
an ordering key with gaps in it, so *Move up* finds the block above **that
exists** — at 2 when the draft reads `0, 2, 5`, never an assumed `4` — and the
two rows swap the positions they already hold. Nothing is renumbered, no value
is written that was not read, and the set of positions is identical afterwards.
The swap is two updates under the draft's claim, with no parking step: the
index on `(presentation_id, position)` is not unique, so the instant between
them needs no spare value. The first version borrowed `-1` for that instant,
`presentation_items_position_check` refused it, and every move threw — found by
Stage F1's tests, because the only existing test was refused for a stale version
before it reached the write. The neighbour is decided again under the claim, an
edge move is a quiet success that writes nothing, two moves from one page give
one winner and one `conflict`, and a Revision already published is never
touched: a reorder reaches a client only as the next Revision.

**Studio offers only a move that can happen.** The first block has no *Move
up*, the last no *Move down*, and a lone block neither — not disabled, not in
the markup at all, so a keyboard never lands on a control that does nothing.
`draftMoves(index, count)` in `lib/workrooms/draft-moves.ts` decides it from
the block's place in the list the page renders, never from `position`: in a
draft reading `0, 2, 5` the block at 5 is last and the one at 2 is in the
middle. The server's quiet no-op for an edge move stays, for a crafted or stale
request.

**Manually accepted on real Railway beta, on `e2c6148`.** *Move up* changed the
real draft order and *Move down* changed it back; the top block rendered only
*Move down* and the bottom block only *Move up*; after a move the controls
followed the new rendered order; the impossible edge controls were absent from
the DOM; and the current published version stayed separate from the draft
edits.

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

### Previous versions — the client may revisit, and only what was published

**A Revision row exists if and only if it was published.** There is no draft
Revision, no scheduled Revision and no Revision written by anything but the
publish transaction — so "may the client open Revision 2?" reduces to "does
Revision 2 exist, in a Presentation they may open?" No flag is consulted and
none can be got wrong.

```
/workrooms/{room}/presentations/{presentation}              the current Revision
/workrooms/{room}/presentations/{presentation}/revisions    what was published, and when
/workrooms/{room}/presentations/{presentation}/revisions/{n}  Revision n, exactly as shown
```

Under `/workrooms/:path*`, so `middleware.ts`'s private cache headers and the
one `robots.txt` line already cover them. No new namespace, no second door.

**The latest is primary and the rest are quiet.** The Presentation opens on its
current Revision with no version chrome at all until a second Revision exists;
then one restrained `Previous versions` control appears. A client who has been
sent one thing is not shown a changelog.

**What a historical Revision renders is the Revision, never today's draft.**
Order, captions, body text and the name under each file come from
`presentation_revision_items` — snapshotted at publication, immutable by
trigger. Files are immutable once `ready`, so the bytes, type and size a
historical Revision names are the bytes, type and size the client saw; a
replacement is a different File and leaves the old Revision untouched.

**Every historical read passes the same gate as every other client read** —
active membership, Workroom `published` and unarchived, Presentation `published`
and unarchived, and `clientVisible()` on each file. A ten-year-old Revision is
not a route around anything; it is the ordinary route, reading older rows.

**Unpublishing takes the whole Presentation back, history included.** That is
the correct granularity: the studio retracts a delivery, not one paragraph of
one version of it. And it is refused outright once a Revision carries a terminal
approval.

---

## Stage B is verified on beta

Exercised by hand on the real Railway beta deployment, Studio on a desktop and
the client on a real phone — not Preview standing in for a client, and not a
test harness standing in for either.

The Presentation was **Brand Direction**: an introduction, one `ready`
**internal** image captioned *Primary identity direction*, and a note headed
*Direction*.

| | |
| --- | --- |
| Draft created, composed, and private to the studio | **passed** |
| Studio Preview rendered the draft's **internal** image | **passed** |
| The File stayed `internal` — Preview shared nothing early | **passed** |
| Publish named the consequence before the press: one file would be shared | **passed** |
| Publishing created **Revision 1** and opened the Presentation to the client | **passed** |
| The referenced File became `shared` | **passed** |
| Activity recorded the file sharing and the Presentation being published | **passed** |
| No email was sent automatically | **passed** |
| The client opened Revision 1 on their phone — image, caption, introduction, note, and the original file downloadable | **passed** |
| The draft was then edited and **not** published; the client still saw Revision 1 and none of the new text | **passed** |
| **Revision 2** published: Studio said *2 versions published*, the client moved to Version 2, Version 1 was preserved and listed beneath it | **passed** |
| The client opened **Previous versions → Version 1**, and its original content was intact | **passed** |
| Studio's own view of Version 1 identified itself as frozen and showed the original introduction, image, caption, download and note | **passed** |
| *Stop sharing* on the File was **refused**, naming Brand Direction and saying the Presentation must be unpublished first | **passed** |
| *Archive* on the same File was **refused**, because what a client was shown has to stay where they were shown it | **passed** |

**The draft-immutability step is the one worth naming.** Editing the live draft
while a client held Revision 1, refreshing their phone, and seeing the old
Revision unchanged is the whole argument for relational immutable Revisions
demonstrated on real infrastructure rather than asserted in a test. Nothing
leaked, because there is no path by which it could: a Revision's items are its
own rows, written once.

**The two guards were tried deliberately and both refused.** They are the pair
that keep *"a client only ever sees a `ready`, `shared`, unarchived File — in a
Revision published years ago exactly as today"* true, and a guard nobody has
attempted to trip is a guard nobody has tested.

**Getting to the client at all needed the invitation journey**, which refused
on beta for three unrelated defects and one configuration fault before it
succeeded. All four are recorded in [`client-auth.md`](./client-auth.md) and are
not repeated here. The invitation is **single use**; the client's later returns
went through the ordinary client sign-in.

**What this does not claim.** Nothing about production — it has no bucket and
has not been touched by Build 005. Nothing about Reviews or Approvals, which
remain schema read by nothing. And nothing about the promotion gates still open
above: the sweep is unscheduled and there is no per-object backup strategy.

---

## Reviews

**Schema, domain, projection, authorization and, now, both surfaces.**
Migration `0006_reviews.sql` is applied and accepted on beta, `lib/db/reviews.ts`
holds the rules, `lib/workrooms/review-view.ts` is the only producer of
client-visible Review data, both worlds have a guarded action layer, and
`components/workrooms/ReviewThread.tsx` renders the round on all four routes.
General and item-level feedback only: **precise anchor capture is stored,
projected and not yet drawn**, and there are no notifications — telling somebody
a round is open is still a separate decision, made by a person.

**Manually accepted on the real Railway beta deployment** — Implementation D/E,
the visible surfaces, end to end. Three defects were found by that walk, fixed at
their cause and retested there; the record is *Reviews are verified on beta*,
below. Stage F (precise annotation interaction) and Stage G (notifications) are
not built, so Stage C as a whole is not complete.

**A Review is one round of client feedback on one published Revision, at the
studio's invitation.** Not a chat, not a ticket queue, not a second Presentation
system, and not an approval — `presentation_approvals` stays a separate table
with its own lifecycle, and a Revision can still be approved with feedback wide
open.

| | |
| --- | --- |
| `presentation_reviews` | the round: one per Revision, ever |
| `presentation_review_notes` | the feedback items and their replies |

### The no-threads rule is withdrawn

`0004` shipped request → response → resolution as three columns on one row, with
threads refused on the argument that they become chat. That argument was made
before the benchmark was gathered, and this document already recorded that it
would be re-argued rather than inherited. It was, and it lost.

Frame.io, Filestage, Ziflow and ReviewStudio all put comments bound to an asset
and a version, with replies and a resolve action, at the *centre* of how review
works. Against four products converging, one paragraph of reasoning does not
hold — and the concrete cost was plain: a client with three thoughts about three
images got one textarea and one shot.

**What actually turns a comment surface into chat is unbounded depth, an
always-open entry point, and a notification per message.** So each is refused
separately, and the first is refused by PostgreSQL rather than by intention:

- **Depth is exactly one.** A reply's parent must itself be a root, proved by
  `(parent_note_id, parent_is_root)` referencing `(id, is_root)`. A reply to a
  reply **cannot be stored**.
- **There is no always-open entry.** A published Revision with no round has no
  feedback affordance at all. The studio asks; the client answers.
- **Replies never send email.** One message per round, on the client's first
  note.

### One round per Revision, ever

`UNIQUE (presentation_revision_id)`, a full unique constraint rather than a
partial index over open rows. The difference is the model: a partial index says
*one at a time*, which is scheduling; a full unique says *one, ever*, which is a
fact about the Revision. It also makes the client projection honestly singular,
which it was not before.

**And the row cannot be deleted**, by trigger, because a unique constraint
somebody can delete their way around is not a rule. The rows most likely to look
disposable are exactly the ones whose existence is the record: a round withdrawn
before anybody wrote, a round closed with no notes, a request never answered.

```
(no row) --request--> open --staff close----> closed/staff  <--> open
                           --publish N+1----> closed/superseded  TERMINAL
                           --withdraw-------> withdrawn      <--> open
```

Reopening a staff closure or a withdrawal is allowed only while that Revision is
still the Presentation's current one — a condition on another table, so the
domain will hold it. **A supersession never reopens**, and the trigger refuses
the two-write route as well as the obvious one: the closure reason cannot be
relabelled while the row stays closed, so `superseded → staff → open` fails at
the first step.

**Why a `closed_reason` column rather than inferring it.** "Exactly one of
`closed_by_user_id` or `closed_by_revision_id`" reads like the right constraint
and is a landmine: every actor foreign key here is `ON DELETE set null`, so
deleting a staff member would empty the staff branch and the constraint would
refuse the deletion. The reason is the fact; the key is the join.

### Feedback belongs to the exact Revision, and the database proves it

A note carries `presentation_revision_id` as well as `presentation_review_id`,
and two composite foreign keys pivot on it:

```
note.(workroom_id, presentation_review_id, presentation_revision_id)
        → presentation_reviews (workroom_id, id, presentation_revision_id)

note.(workroom_id, presentation_revision_id, revision_item_id)
        → presentation_revision_items (workroom_id, presentation_revision_id, id)
```

**A note on Revision 2 cannot reference an item from Revision 1**, even inside
one Workroom, one Presentation and one client relationship. Tenancy alone would
have allowed it, and that would have quietly falsified the sentence Stage B
exists to make true. Nothing migrates feedback forward: Revision N+1 begins with
its own empty round, and Revision N's notes stay where they were said.

### General, item-level and precise, in one representation

```
revision_item_id NULL,     anchor NULL     →  about the Revision
revision_item_id set,      anchor NULL     →  about that item
revision_item_id set,      anchor set      →  about a place or a time in it
```

An anchor without a subject is refused: there is no point at 42% of a Revision.

**Coordinates are normalised fractions of the media's own intrinsic box, and
seconds from its start — never viewport pixels.** A phone and a desktop resolve
to the same place, and a later overlay or side-by-side comparison stays
possible. The database holds the cheap half — the kind is one of `point`,
`region`, `time`, every coordinate is between 0 and 1, `t >= 0`, `t2 > t` — and
`parseAnchor` in `lib/db/reviews.ts` holds the exact shape, the way every
client-safe projection is a whitelist rather than a filter.

**The parser refuses rather than normalises**, so a caller never gets back a
different anchor from the one it sent. An unknown key, an unknown kind, `NaN`,
`Infinity`, a string where a number belongs, a coordinate outside the box, a
viewport pixel, `t2 <= t`, a point with no `y` — each is a refusal.

**And what precision can mean is decided by the viewer, not by the caller.** The
parser is given the item's own viewer kind, resolved from the Revision item
under review, and refuses a temporal anchor on an image, a spatial one on audio,
a frame region on anything but video, any anchor on a PDF or a download, and any
anchor at all on a written note — there is nothing there to point at. An anchor
with no subject is refused before any of that.

**What precision can mean is decided by the viewer, not by ambition.** `image`
and `video` render through elements we own, so a point or a region is real.
`audio` gets a timestamp shown as a text locator that seeks, because
`<audio controls>` is the browser's and we cannot draw in its scrubber — and
neither can we in the video's, so the video marker sits on the frame. `pdf`
renders in an iframe running the browser's own viewer, which is opaque to us, so
PDF feedback is item-level until there is a reason to adopt a PDF renderer. The
anchor column already fits `{kind: "page", …}` on the day there is.

### Authorship, resolution and removal

**Staff cannot open a feedback item.** Enforced by a CHECK: a root must be
client-authored. The studio's contribution is replies, resolutions and the next
Revision — a studio that can raise items on its own work has built a shared
to-do list, not a client's voice.

**Either side may resolve; the client may reopen what the studio resolved**, for
as long as the round is open. *Resolved* therefore means *the studio believes
this has been dealt with*, and the client can say otherwise. Resolution hides
nothing, moves nothing and deletes nothing.

**Removal is the one thing the earlier draft got wrong.** "No deletion, ever"
was recorded here as discipline and it was not the professional standard —
mature products let an author remove their own comment under defined conditions.
Trapping somebody who pasted the wrong paragraph into a client-facing surface is
not rigour. So: **an author may remove their own note**, only while the round is
open, only within fifteen minutes, only while nothing has replied to it, and
only once.

**It is a tombstone, not a delete.** `removed_at` is written **beside** the body
rather than over it, so the immutability rule needs no exception and the record
is not falsified. The **row** keeps its ordinal, its authorship, its timestamps
and its Audit trail. The **projection** keeps two fields:

```
{ n: 1, removed: true }
```

and that is the whole of `ClientRemovedNote`. Not a note with its words hidden —
its own type, so there is no author, no time, no `subject`, no anchor, no
resolution and no `edited` on it to read, to render, or to serialize into a
flight payload. It renders as one line, in both worlds:

```
Comment removed
```

**Beta found this one implemented as a header with the words removed.** The
tombstone read *Yehuda Weller · 23 Sept, 20:44 · This was taken back.* — the
body was gone and everything around it was still there, which narrates who took
something back and when. That is the record a removal exists to stop leaving,
and the copy was a second drift from the same lock, which had said *Comment
removed* from the start.

The correction is not a check in the renderer. `ReviewThread` does short-circuit
before the header, in both positions a note can sit — but the guarantee is the
type: reading an author off a tombstone does not compile, and there is nothing
in the response to find whatever the markup does. **Adding a field to
`ClientRemovedNote` costs the same thing twice**, once in the markup and once
on the wire.

*Comment removed* is deliberately neutral. It says what happened to the thread
and nothing about the person, and the thread's own order is what keeps the
point's place in the conversation, so nothing else has to. The **action** is
still called *Take back*, because that is what the author is doing; the
permanent state it leaves is not narrated back at them.

A removed root carries no replies either, and that is the domain's guarantee
rather than the projection's opinion: `claimOwnNote` refuses a removal once
anything has answered, and `replyToReviewNote` refuses a removed parent, so a
tombstone has none and can never gain one.

**And no projection returns the body to either surface — staff included.** There
is one projection for both worlds, so a staff-only body would mean a second one,
which is precisely the drift that produced the Stage A Preview defect and the
Stage B route defect. The thing most likely to be removed in a panic is
something private, and a removal the studio can still read is not a removal.
Reaching the stored text means an Owner querying the database deliberately,
which is the right amount of friction for the right rare reason.

**Restore is refused by trigger.** `removed_at` cannot be cleared. A restore
would make *removed* a toggle, and the other side may already have read it.

### What the database holds, and what the domain holds

| Rule | Held by |
| --- | --- |
| One round per Revision | **PostgreSQL** — `UNIQUE` |
| A note's item belongs to the reviewed Revision | **PostgreSQL** — composite FK |
| Depth exactly one | **PostgreSQL** — composite FK on `(id, is_root)` |
| A root admitting to be the studio's | **PostgreSQL** — CHECK |
| A supersession is terminal and unrewritable | **PostgreSQL** — trigger |
| No delete, no truncate, no restore | **PostgreSQL** — triggers |
| Body immutable after fifteen minutes or after removal | **PostgreSQL** — trigger |
| **No edit or removal once a reply exists** | `lib/db/reviews.ts`, under the round lock |
| The round must be open; the actor must be the author | same |
| **A studio actor cannot open a feedback item at all** | same |
| Reopening requires the Revision to be current | same |
| The exact anchor shape, against the item's viewer | same |
| Active membership, read on every call | same |

The lower half needs another row, and a per-row trigger doing child counts would
pay for that on every write. Each is named rather than half-held by a CHECK,
because a constraint that half-holds a relational invariant reads like
protection and is none.

**One of them is stronger than the lock said it would be.** The CHECK refuses a
root that says `author_side = 'studio'` — but a studio actor cast into the
client's shape would have been stored as a client, with nobody behind it. The
domain refuses the actor rather than the column, and a test proves the cast no
longer works.

### The round lock, and why there is only one

```
presentations  →  presentation_reviews  →  presentation_review_notes
```

Never acquired upward. **Every mutating function in `lib/db/reviews.ts` opens by
locking the Review row**, which is the round's single serialization point: every
mutation of a round passes through it, so a second lock on the root note would
protect nothing the first does not — and a second lock is a second chance to
order it wrongly, which is how deadlocks are actually born.

Only two paths reach `presentations`, and both take it first: `reopenReview`,
whose precondition is `current_revision_id`, and `publishPresentation`, which
already held that lock before Reviews existed. A concurrent publish and a
concurrent reopen therefore serialize instead of racing.

The lock is a convention held in one module. The backstops behind it are
structural, so a mutation written outside it fails loudly rather than corrupting
a round quietly: the note's optimistic `version`, `UNIQUE (presentation_review_id,
number)`, and the `0006` triggers.

**Proved under real load**, in `tests/reviews-concurrency.test.ts`: two roots at
once take two ordinals; a reply racing a removal never lands on a tombstone; an
edit never lands after the reply it would have preceded; a withdrawn round never
holds feedback; a superseded version is never left open; two decisions on one
point produce one clean conflict; and a storm of every operation at once
deadlocks nothing. Each race runs both start orders, because the first call
started reliably takes the lock — measured, after one race went the same way six
times out of six and left half its assertions unreached.

### Publishing ends the round it replaces

Inside `publishPresentation`'s own transaction, after the optimistic gate and
before the Activity row. The outgoing Revision is re-read under the lock rather
than taken from the row loaded before it, because a concurrent publish may have
moved the pointer.

It closes the container and touches nothing inside it: no note is resolved, no
feedback is copied forward, no round is created for the new Revision, and
publishing is never blocked by an open one. A round staff already closed keeps
that reason; a withdrawn one stays withdrawn. **Publishing is the studio's answer
to feedback, not a rewrite of what was said.**

### One projection, for both worlds

`lib/workrooms/review-view.ts` produces `ClientReview`, and **Studio renders the
same thing the client does.** There is no `StaffReview`, no
`InternalReviewView` and no second copy of the shape — the Stage A
`WorkroomOverview` drift and the Stage B route defect were both a second
representation drifting from the first, and this is the third place that lesson
applies. Internal controls compose *around* it; they never reach inside.

```
ClientReview       { status, requestedAt, canWrite, closedNote?, notes[] }
ClientReviewNote   { n, author, at, body?, removed, edited,
                     anchor?, resolved, resolvedBy?, replies[] }
ClientReviewReply  { n, author, at, body?, removed, edited }
ClientAuthor       { name, side }
ClientAnchor       { item, kind?, x?, y?, w?, h?, t?, t2?, region? }
```

**No database identifier appears in any of those types.** A note is named by
`n`, its ordinal within the round; an item by `item`, its position in the
Revision. Both are small integers scoped to something the caller has already
been authorized for, which is what makes them safe to hand out — and it means
there is no path from a form back to an id, because there is no id to send.

**A removed note's words leave for nobody.** Not the client, not the studio, not
an Owner. The projection drops the body, the anchor, the resolution and the
reply affordance together, and there is no second path that carries them. The
row keeps the text so the record is not falsified; reaching it means an Owner
querying the database deliberately.

**A withdrawn round projects as null** — to both worlds. A retracted request is
the studio's administration and should look exactly like one nobody asked for.
Studio learns it was withdrawn from its own surrounding controls, not from this
shape growing a fork.

**A stored anchor that does not match the Stage C vocabulary fails closed.** The
note keeps its subject, which is a position read from a join and therefore known
good, and loses the precision nobody can vouch for. Nothing arbitrary crosses
the boundary: every emitted field is named in the module.

### Writeability is decided on the server

`canWrite` is computed from the round's state and the caller's standing, and a
surface never recomputes it. A page that decided for itself would be a second
authorization system, and the wrong one would eventually win. A closed round is
false for everybody, whichever world is asking, so a historical Revision is
read-only because its round is closed rather than because of a separate rule
about history.

### The two boundaries, and what a refusal says

| | Staff | Client |
| --- | --- | --- |
| Guard | `requireStaff` | `currentViewer` |
| Reader | `reviewForStaff(workroomId, presentationId, revision?)` | `reviewForViewer(contactId, room, presentation, revision?)` |
| Surface reader | `reviewPanelForStaff` — projection, sidecar and lifecycle | `reviewPanelForViewer` — projection and sidecar |
| Scope | the Presentation's own Workroom; unpublished included | membership active, Workroom and Presentation published and unarchived |
| May | request, close, withdraw, reopen, reply, resolve, reopen a note, correct and take back **their own reply** | open a feedback item, reply, edit and remove their own, resolve and reopen their own |
| May not | open a feedback item, edit or remove a **client's** words | anything about the round's lifecycle |

Membership is **part of the query**, not a check after it, so a non-member's
request never reads the round at all — the `workroomForViewer` discipline,
restated rather than reinvented.

**Every refusal at the boundary is the same null.** A wrong Workroom, a wrong
Presentation, a wrong Revision, a Revision with no round, a withdrawn round and
a Contact with no membership all produce it. Concealment over explanation: a
surface that could tell them apart would be telling somebody outside the company
about the studio's administration, or about a Workroom that is not theirs.

**No version reaches a browser, and that is a decision.** Every Review mutation
holds the round's row lock from its first read to its commit, so the version
read under that lock is the version the update finds; an `expectedVersion` from
a form would add nothing the lock does not already give, and would put a raw
database counter on a page to get it. Two people pressing *Resolve* at once
still each get one clean answer — the second is told it is already dealt with.
`expectedVersion` stays available to a caller that holds one, which is how the
tests drive conflicts deliberately.

**Reviews block nothing.** A Revision can be approved with an open round, or
reviewed and never approved. Two acts, two records.

**Version comparison is architected, not built.** Nothing in this model
prevents side-by-side, synchronised navigation or an overlay: notes are bound to
their own Revision, items are keyed by position, and anchors are normalised
against the media rather than the screen. It is not built because two tabs
already work.

### Publishing tells you it will end the round

Publishing over an open round supersedes it — terminally, and on purpose. Beta
found the confirmation saying only *The client will see this instead of the
current version*, so somebody about to close a conversation with a client was
not told they were doing it. The dialog now says:

```
Publish a new version?
The client will see this instead of Version 2. Feedback on Version 2 will
close and remain available as read-only history.
Cancel · Publish
```

| The round on the version being replaced | Said in the dialog | What publishing does |
| --- | --- | --- |
| none | nothing about feedback | nothing to close |
| open | *Feedback on Version N will close…* | closes it, `superseded`, for good |
| closed by the studio | nothing about feedback | keeps it closed, reason `staff` |
| withdrawn | nothing — not even an allusion | leaves it withdrawn |

**Only the open case is disclosed, because only the open case changes.** Saying
a closed round will close would promise a consequence that does not happen, and
mentioning a withdrawn one would surface administration the studio chose to take
back. `openRoundOnCurrentRevision` reads the same column the transaction reads —
`current_revision_id`, whatever the Presentation's status — so a presentation
withdrawn with its round still open warns correctly on republish, which a
"published only" reader would have missed. Each row of the table is tested by
reading the dialog and then publishing and checking the round.

The words live in `lib/workrooms/publish-copy.ts`, a pure function of four
facts. The files sentence still leads when there are files to share; the
feedback sentence is added, never substituted, because it is a different
consequence. The version is named by number, never by row.

Advisory, like every sidecar here: a round closed between render and press
means one warning that turned out unnecessary, never a consequence nobody was
told about. Publishing itself is unchanged.

### One number for a block, and the beta defect that needed it

A **draft**'s `position` is an ordering key. `removeItem` does not renumber —
"positions may hold gaps after a removal, and the only thing anything reads is
their order" — and `nextPosition` is `max + 1`. So the first time somebody drops
a block, a draft reads `0, 2, 3, 4`.

A **Revision**'s items were written densely, by array index: `0, 1, 2, 3`. The
frozen snapshot kept the draft's numbers. One block therefore had two numbers,
and the Review path crossed between them twice:

| Step | Which number |
| --- | --- |
| the client's subject picker | a snapshot position |
| `createReviewNote`'s lookup | a `presentation_revision_items.position` |
| the reader | a `presentation_revision_items.position` |
| `labelAt` | a snapshot position |

Reproduced against a real database, through the real form, before the fix:
picking **Full identity presentation** attached the note to **Master artwork,
for your archive**, and picking the last block was refused outright with *That
part of the work is not in this version.* Neither is visible from inside the
domain, and neither shows up on a draft nobody has edited — which is why every
test passed and beta did not.

**A published Revision is a finished sequence, so its positions are that
sequence.** `presentedItems` numbers the blocks that survive projection by their
place in it, and hands publish the source row beside each one so the snapshot
and `presentation_revision_items` are filled from a single filtered list rather
than by two functions happening to agree. `readSnapshot` renumbers on the way
out, which repairs every Revision frozen before this: the rows are immutable and
are **read** rather than rewritten, exactly as the legacy file paths inside them
already are. The order is untouched, so nothing about what a client was shown
changes — only the label on each place in it, and it now agrees with the
relational items it has always been in step with.

The stored `content_hash` is not recomputed from a read snapshot anywhere, so
nothing that was published keeps a different answer to *is this the same work
the client saw?*

### Subject and anchor are two things

`ClientReviewNote` carries them separately:

```
subject?: number      which block, by its position in the Revision
anchor?:  ClientAnchor   where inside that block, when somebody said
```

**Item-level feedback is a comment about a block and carries no anchor at all**,
which is the whole of what this build can produce. A precise anchor is
additional, never implied, and never present without a subject — "say which part
of the work this is about" is the domain's rule and this is the projection
agreeing with it rather than inferring the subject back out of an anchor.

They were one shape, where `{ item: 2 }` meant *item-level* and
`{ item: 2, kind: "point", … }` meant *precise*. That works until somebody
writes a guard on the anchor and silently takes the block's identity with it —
and it made the common case look like a degenerate annotation rather than the
ordinary thing it is. The Stage F vocabulary is unchanged; only the redundant
`item` inside a projected anchor is gone, because the note already carries it.

A malformed stored anchor still fails closed, and now fails closed to **nothing**
rather than to an item: losing an anchor costs a note its pin and never the
block it is about.

A block that cannot be named — a position this Revision has nothing at — renders
as `Item N` rather than as silence. Beta's defect was a locator that simply was
not drawn, and a fallback is cheaper than finding that out twice.

### The surfaces — one thread, four routes

`components/workrooms/ReviewThread.tsx` renders the round, and it is the only
thing that renders a round. Four routes use it:

| Route | Reads | Writes through |
| --- | --- | --- |
| `/workrooms/{room}/presentations/{p}` | the current Revision's round | the client actions |
| `/workrooms/{room}/presentations/{p}/revisions/{n}` | that Revision's round | the same, refused because closed |
| `/studio/workrooms/{id}/presentations/{p}` | the **current** Revision's round | the staff actions |
| `/studio/workrooms/{id}/presentations/{p}/revisions/{n}` | that Revision's round | the same |

**There is no `if (isStaff)` inside it.** Not in the markup, not in the copy,
not in the ordering. The content is a `ClientReview` — one projection, the same
for both worlds — and every control is drawn from a capability sidecar the
server computed. Which world is rendering shows up in exactly two places, both
outside the content: the one `lead` sentence a page passes in, and which server
actions it hands over. A capability that is true with no action behind it draws
nothing, so neither is load-bearing on its own. A test scans the component for
`isStaff`, `StaffReview` and their relatives and fails if one appears.

It carries **its own stylesheet**, built from the global tokens rather than from
Studio's `--s-*` or the Workroom's `--w-*`. A component that reached for either
would render unstyled in the other world, and one that reached for both would be
the fork moved into CSS. The thread therefore looks the same to both parties,
which is what it is.

### The capability sidecar — guidance, never security

`lib/workrooms/review-capabilities.ts` answers *what may this person do*, as
booleans, keyed by a note's ordinal:

```
{ comment: boolean,
  notes: { [n]: { reply, edit, remove, resolve, reopen } } }
```

It exists because the two things a surface would otherwise have to work out for
itself are exactly the two it cannot: **whether this person wrote that note**,
which is a comparison against an author id the projection deliberately does not
carry, and **whether the fifteen-minute window is still open**, which a
browser's clock has no business answering. The author keys are read inside
`lib/db/reviews.ts`, compared, and thrown away as `mine`; no identifier travels
as far as this module.

**It is not a permission system.** Every server action re-authorizes from
scratch — the caller, the Workroom, the Presentation, the Revision, the round,
the note, the window, the authorship — inside the transaction that holds the
round's row lock. The sidecar's only job is that a control nobody may press is
not drawn. A test presses the withheld ones anyway, against a real database, and
asserts the domain refuses every one and that the round is byte-identical
afterwards.

**It carries booleans and nothing else**, which is why it is a second object
rather than fields on `ClientReview`. A permission flag living inside the shape a
removed body is kept out of gives the next person a fifty-fifty chance of adding
the wrong kind of field to it. A leak test serialises the whole sidecar and
asserts no identifier, no marker and no note text is anywhere in it.

Its facts are derived from the same rows the projection is built from, in the
same request, so the two can never disagree about which notes exist. A removed
note keeps an entry with every flag false: leaving it out would make a missing
key mean two different things.

### The lifecycle — Studio's alone

`lib/workrooms/review-lifecycle.ts` is the one thing Studio gets that the client
does not:

| State | Means | Offers |
| --- | --- | --- |
| `none` | nobody has been asked about this Revision | Ask for feedback |
| `open` | the client may write | Close; Take the request back, while nothing is written |
| `closed` | the studio ended it | Reopen, while this is the version the client is reading |
| `superseded` | a newer Revision ended it | nothing — terminal in the domain and in a trigger |
| `withdrawn` | asked, and taken back before a word | Ask again |

It exists because `toClientReview` returns **null** for a withdrawn round —
correctly, for a client, to whom a retracted request should look exactly like one
never made. Studio still has to tell *nobody has asked* from *I asked and took it
back*, or the same person asks twice. Rather than fork the projection, the fork
is a separate object carrying five states, one Revision number and four
booleans, and **not one word anybody wrote**. A test serialises it and asserts
the same.

*Take the request back* disappears permanently the moment anybody writes, a
comment that was taken back included: the row exists, the ordinal is spent, and
presenting an untouched round to somebody who had already used it would be a lie
about their own Workroom. The button is absent rather than refusing.

### What each world says, and when

The client sees:

| | |
| --- | --- |
| no round, or withdrawn | **nothing at all** — no heading, no empty state |
| open | *The studio asked for your thoughts on this version.* and somewhere to write |
| closed by the studio | the thread, read-only, and one quiet line saying so |
| superseded | the thread, read-only, and *closed when version N was published* |

Studio sees the same thread with the same words, and its administration above
it. It is offered no way to open a feedback item — a CHECK refuses a
studio-authored root, the domain refuses the actor, and there is no action —
but it **can** correct and take back **its own reply**.

**That last one revises Implementation C.** Those two actions were left out while
Studio had no way to write at all: with no reply there was nothing to correct.
Their absence once Studio can reply would mean the studio can put a sentence in
front of a client and never take it back, while the client can take theirs back
within fifteen minutes. The domain always allowed either side, the five
conditions are unchanged, and `claimOwnNote` compares the author key — so they
reach a studio reply and nothing else. Asserted against a running database
rather than by a source scan, because *whose note is this* is not a question a
scan can answer.

### Confirmations, in two worlds

Remove, resolve, request, close and withdraw each open the platform's one
`ConfirmDialog`. It was Studio's, and a modal renders in the browser's top layer
— outside whichever token root the page has — so it now **composes** Studio's
token block onto itself rather than inheriting it. One line of CSS, no second
dialog, and no copy of the values to drift. Measured in a real browser in the
client world: 32px padding, a 1px rule at `rgba(255,255,255,.18)`, black ground,
a 38px button, Cancel holding the focus, and Escape mutating nothing.

---

### Stage F — precise anchors: the lock

**Architecture, with its foundation (F1), its display (F2) and audio capture
(F3) built, below; nothing yet captures a video time, an image point or an
area.** Stage F answers one question a
feedback point sometimes needs — *exactly where do you mean?* — without turning
a Workroom into a drawing application. Precision is always optional: general
feedback and item-level feedback stay exactly as they are, and remain the
ordinary case.

**Adopted.** Image **point**. Video **moment** and video **stretch**. Audio
**moment** and audio **stretch**. And **return to context** — activating a
locator brings the reader to that place in that version's media — which is the
part of the benchmark that makes precision worth having.

**Deferred, architected.** Image **region** capture and display; a **region on
a video frame**; **PDF page** anchors. **Refused.** Freehand, arrows, lines,
circles, colours, an annotation toolbar, a waveform, a custom audio player, a
custom video timeline, text highlighting, OCR, always-on marker overlays.

| Decision | Why |
| --- | --- |
| Point, not region, on images | A point and a sentence covers what a region does in almost every real comment. A region needs a drag, which fights scrolling on a phone, and an accessible keyboard equivalent that is disproportionate for the value. The vocabulary already holds `region`; it waits for a reason. |
| No spatial anchor on video | The video sits in native controls that occupy its lower edge, goes native-fullscreen where no overlay follows, and letterboxes inside its own element (`width: 100%` with a capped height). A moment is what video review actually runs on. The vocabulary already holds `time + region`. |
| No PDF anchors | The PDF renders in the browser's own viewer, inside an iframe that reaches **another origin** after the redirect, so the page cannot read which page is showing, and many phones do not render it inline at all. Doing it properly means pdf.js — replacing the accepted viewer — which is a decision of its own, not a side effect of this one. PDFs keep general and item-level feedback. |
| Native players untouched | Capture reads `currentTime`; return-to-context sets it and pauses. No scrubber, no waveform, no marker drawn into a browser control. |

**No migration.** `subject` (`revision_item_id`) plus the `anchor` jsonb already
represent everything adopted, and the composite foreign keys already pin an
anchor to its exact Revision.

**The parser had a hole, and closing it was the first step (F1).** `region()`
checks that `x`, `y`, `w` and `h` are each between 0 and 1 and nothing else, so
`{ x: 0.9, y: 0.9, w: 0.9, h: 0.9 }` — nine-tenths of it outside the image — was
accepted, as was a region of zero size, and the client action would store
either for anyone who posted one. Nothing draws regions yet, so nothing is
wrong on screen. The region rule becomes `w > 0`, `h > 0`, `x + w ≤ 1`,
`y + h ≤ 1`, written once, in the canonical parser below; anything stored
before fails closed on read.

#### One anchor parser, used on the way in and on the way out

Before F1 there were two validators and they already disagreed. `parseAnchor` in
`lib/db/reviews.ts` checks exact keys and the media type; `toClientAnchor` in
`lib/workrooms/review-view.ts` has its own `FRACTION`, `SECONDS` and `box()`,
**does not check exact keys**, and cannot check the media type because the
reader never tells it what the item is.

**`lib/workrooms/review-anchor.ts` becomes the only definition of a valid
anchor.** Pure and server-safe — no database import, no browser API. It owns
the discriminated union, the exact-key whitelist, the finite-number checks, the
point, region and time rules, and which media each kind belongs on. It returns
the anchor or a machine reason, never a sentence.

- **Writing.** `createReviewNote` calls it before storage and maps a refusal to
  the sentence a person reads. The copy stays in the domain; the rule does not.
- **Reading.** The projection calls the same function on the stored jsonb and
  fails closed — the note keeps its `subject` and loses only the anchor. For
  that, `reviewNotes` returns each item's **viewer kind** alongside its
  position, so the projection can apply the media-type rule without importing
  anything from `lib/db`. The viewer is read from **the Revision's frozen
  snapshot**, never the live file row — see F1 below.
- **The browser** has capture helpers that produce candidate values; it has no
  authority. `readAnchor` stays what it is — a transport reader that parses JSON
  under a 400-character cap and judges nothing.

No invariant — `x + w ≤ 1` or any other — is written in two places.

#### Time

A stored moment is a **finite number ≥ 0**; a stretch adds `t2 > t`. **There is
no upper limit on a stored time**, and no product rule that anchors live inside
some duration: the server cannot know a file's duration without probing media,
which it deliberately does not, so a stored value that was valid when written
stays valid as history. JSON cannot carry `NaN` or infinity, and `readAnchor`'s
400-character cap is already the only bound an abusive value needs; the label
formatter renders any finite number without breaking.

Duration is enforced **where it is known — at capture**: the controls are
unavailable until the element reports a finite `duration`, and a moment or a
stretch that does not fit inside it cannot be chosen. On **display**, a stored
time beyond what the loaded media reports is a fact about that file, not an
error in the note: the words and the locator stay readable, and the seek is
clamped or declined at the media-control layer only. Stored history is never
rewritten to match a file.

#### The spatial rendering contract

A normalized coordinate means something only if the layout it was measured in
is fixed. For every element that can carry a spatial anchor — an image now, a
video frame when that ships — the stylesheet declares, explicitly rather than by
inheriting a browser default:

```
object-fit: contain;
object-position: 50% 50%;
```

Today the image already renders at its own aspect ratio, so its box *is* its
content; the video does not — `width: 100%` under a capped height letterboxes it
inside its own element. The same helper handles both without knowing which.

**One pure function, four inputs, both directions.** Given the intrinsic size
(`naturalWidth` × `naturalHeight`, which browsers report *after* EXIF
orientation) and the element's **content box** — its bounding rectangle less
its own border and padding — it fits the intrinsic aspect ratio inside that box,
centred, and returns the **content rectangle**.

- **Capture:** pointer → content-local → `x = (px − left) / width`,
  `y = (py − top) / height`. A pointer outside the content rectangle — above,
  below, left or right, in any letterbox — is **no anchor**, not a clamped one;
  the edges themselves are inside.
- **Display:** `x`, `y` → content-local → the marker's position, recomputed when
  the element resizes.

Pointer coordinates and bounding rectangles are both in the same CSS pixel
space, so browser zoom and pinch cancel out in the fraction. Nothing is measured
against the Presentation, the `FileViewer` wrapper, the page or the viewport
without first passing through the content rectangle. Anchors are measured and
shown on the full-view element only, never on a thumbnail.

#### Refreshing an expired media URL — once

Inline URLs last fifteen minutes (`VIEW_TTL_SECONDS`), and Stage A already
recorded that a seek is a fresh request against the redirected, signed address —
so on a page left open, a seek can fail with nothing wrong except the clock.
Whether the browser re-requests our route by itself is measured in F6; if it
does, no code is added. If it does not:

1. The locator's operation tries the seek or the display against the element
   as it is.
2. Only if the element **had loaded before** and now errors — which is what a
   lapsed signature looks like, and what a file that never played does not —
   the element's `src` is set back to **our own route** and reloaded, **once**.
   Images, which the browser caches per address, get a throwaway query
   parameter the route ignores.
3. The operation waits for `loadedmetadata` (or `load`), bounded by a timeout.
4. Then it performs the pending seek or display.
5. If that fails too, it stops. The feedback stays readable, no half-drawn
   marker is left, and the download is untouched.

A refresh happens **only inside an operation somebody started**, at most once
per operation and never twice at the same time for one element; no error
listener outside an operation ever reloads anything. Nothing stores, reads back
or passes on a signed address — the element is only ever given our route.

#### Stretches on a phone

A stretch is kept, and it is harder than a moment: two deliberate presses
against a native player a phone controls, which may go fullscreen and whose
scrubbing is coarse. The benchmark is not uniform here either — Frame.io's iOS
documentation says anchored comments work but adjusting timestamps and ranged
comments are not currently available in its iOS app.

**Start here / End here stays the model**: each reads `currentTime`, the summary
shows the choice, either end can be pressed again. No drag, no timeline, no
custom scrubber to buy parity. A **real phone stretch is part of manual beta
acceptance**. If it proves unusable there, phones get moments only — the
stretch control withheld under `(pointer: coarse)` — rather than a stretch that
half works.

#### Capturing where the work is

The composer sits below the Presentation and the work it is about may be a long
way above it. Nobody should have to pick a subject at the bottom, scroll up to
work the player, scroll back and press a button that is nowhere near what it
measures.

- After choosing a block that can take precision, the composer offers one
  control: **Point to it** for an image, **Set precise time** for video or
  audio.
- Pressing it scrolls **to that one block** and opens a small capture panel
  beside it — a point target on the image, or **Use this moment** and
  **Start here / End here** under the player — and moves focus there.
- **Done** returns to the composer and to the text; **Cancel** or Escape does
  the same and keeps nothing.
- The composer then shows the choice in words — *A point on Primary identity
  direction*, *At 0:42*, *0:42–0:51* — with **Change** and **Clear**. Changing
  the block clears it.

The panel exists only while one draft is being written, on only the block that
draft is about. No block carries capture controls otherwise. This fits the
structure the lock already has: the coordinator that wraps the work and the
round is what lets a control in the composer open a panel beside media rendered
far above it, without either component learning the other's markup.

**Display is opt-in and quiet.** Artwork is clean by default. A locator reads
*On Primary identity direction · a point*, *At 0:42* or *0:42–0:51*; activating
it scrolls to the block, shows that one marker — a double ring legible on light
and dark work — or seeks and pauses. One marker at a time, never all of them.

**One `FileViewer`, one coordinator.** `FileViewer` stays the only renderer and
never learns ids or authorization. A page that shows both the work and its
round wraps them in one small client coordinator; outside it — the Files pages,
Preview — every viewer behaves exactly as it does now. Studio's presentation
page shows the draft, not the Revision's media, so its locators link to that
Revision's own page, carrying **only the note's ordinal**; geometry never
travels in a URL.

**Unchanged rules.** Anchors are written once, with the root, by the client.
Editing changes words only. Replies never anchor. A tombstone carries nothing.
Resolution never touches an anchor, and a historical round navigates within its
own version, never the current one.

#### F1 — the foundation, built

**One parser, both directions.** `lib/workrooms/review-anchor.ts` is the only
definition of a valid anchor: `parseReviewAnchor(raw, viewer)` returns the
anchor, `null` for none, or a machine reason — `invalid_shape`,
`unknown_key`, `invalid_number`, `out_of_bounds`, `invalid_region`,
`invalid_range`, `unsupported_for_viewer` — and never a sentence. It imports
one type and nothing else. `parseAnchor` in `lib/db/reviews.ts` now only turns
a reason into the sentence a person has always read; `toClientAnchor` in
`lib/workrooms/review-view.ts` calls the same function on what is stored and
fails closed to no anchor, keeping the note and its `subject`. `FRACTION`,
`SECONDS` and `box()` are gone, and a source scan keeps them gone.

**The viewer comes from the Revision, not the file.** Both directions judge an
anchor against `file.viewer` in **that Revision's frozen snapshot**
(`viewersByPosition` in `lib/workrooms/presentation-view.ts`, on the same dense
positions `readSnapshot` returns). The live `workroom_files` row is not
consulted: a point on Revision 2's image stays a point on an image after the
draft is reordered and Revision 3 shows a video in that position, and after the
file row itself changes. A snapshot item with no viewer reads as `download` and
fails closed.

**Tightened.** Regions need `w > 0`, `h > 0`, `x + w ≤ 1`, `y + h ≤ 1` — at the
top level and inside a frame region. Every object has exactly its keys.
**Time has no ceiling**: any finite `t ≥ 0`, `t2 > t`; a recording longer than
a day is still addressable. Which kinds each viewer takes: image — point,
region; video — moment, stretch, moment with region; audio — moment, stretch;
PDF, download and a written note — none.

**`0006`'s CHECK is a coarser backstop, deliberately.** It enforces the kind,
the required keys, fractions in [0, 1], `t ≥ 0` and `t2 > t`. It does not know
`x + w ≤ 1`, a zero size, an extra key, a nested region's shape or the viewer —
so it never refuses what the parser accepts, and a row it lets through that the
parser does not is simply not shown as an anchor. No migration, and no stored
row rewritten; tests plant such rows directly and read them back.

**Primitives, for the surfaces to come.** `lib/workrooms/anchor-geometry.ts`
maps between a pointer and a fraction of the media's **content rectangle** —
the `contain`, centred box the pixels actually occupy — refuses a press in the
letterbox rather than clamping it, and holds the stored precision (four places
of a fraction, a millisecond). `lib/workrooms/anchor-label.ts` says an anchor in
words — *At 0:42*, *0:42–0:51*, *At 25:03:08* — as a duration, never a time of
day. Both are pure: no DOM, no clock.

**Still not built at F1:** capture, markers, return to context, seeking, the
coordinator, any `FileViewer` change, any visible anchor, and Stage G. F2,
below, has since built the display half.

**Found while testing, and fixed on its own afterwards.** Studio's *Move up* /
*Move down* could not succeed: `moveItem` parked a row at position `-1` and
`presentation_items_position_check` (`position >= 0`) refused it, so the action
threw. The only test of it used a stale version and was refused before reaching
the write. Fixed as a separate Stage B patch before F2 — see *Reordering* under
the draft's version, above.

#### F2 — display and return to context, built

**A locator answers *show me exactly what this comment is about*, and only
when asked.** Nothing moves because a Review is on screen: the work stays clean,
no marker is drawn and no player is touched until somebody presses one. Then
exactly one context is active — pressing another replaces it; pressing the
same one again, Escape, or leaving the page clears it.

**Which notes have one.** A live root note with a block *and* an anchor
(`locatable` in `lib/workrooms/review-locator.ts`). Its locator takes the place
of the plain *On …* line and reads *On The board · Point*, *On The board ·
Area*, *On The motion · At 0:42*, *On The sound · 1:12–1:24* (`locatorLabel`).
Item-level notes keep the D/E line unchanged; general notes, replies and
tombstones have none; a resolved note keeps its locator, because what was dealt
with is still history.

**One coordinator, and a small one.** `components/workrooms/ReviewStage.tsx` is
the only client island: `ReviewStage` wraps the work and its round on the four
pages that render a Revision beside its own round; `AnchorTarget` registers each
presented file under its **dense Revision position**; `ReviewLocator` is the
button. It holds registered elements, the one active note (`n`, position,
anchor) and a pending seek — no identifier, no signed address, no Review state,
no rule. `PresentationView` and `ReviewThread` stay server components, and
outside a stage `AnchorTarget` renders its children untouched, so the Files
pages, Preview and the one `FileViewer` are exactly as they were.

**Image point.** Scrolled into view (`smooth`, or immediate under
`prefers-reduced-motion`), focus handed to the block, and one double-ring marker
— white between black, no animation, `pointer-events: none` — placed through
F1's `containRect` on the image's content box (its bounding rectangle less its
own border and padding), then expressed relative to the block. A
`ResizeObserver` on the image and the block moves it with a resize or a
rotation. `.viewerImage` now declares `object-position: 50% 50%` beside its
`object-fit: contain`, as the rendering contract requires.

**Video and audio.** Scrolled to, paused, focus on the player, then — once
metadata is known — `currentTime` set and left paused. Nothing calls `play()`.
A stretch seeks to its start; there is no loop and no restriction to the range.
If metadata is not ready the seek waits for `loadedmetadata`, bounded by ten
seconds, with one listener pair per wait that a newer press removes; an
`error` or the timeout gives up quietly. A stored time past the reported
duration is **declined, not clamped** (`seekPlan`): the player stays where it
was and the label is untouched, because parking at the end would claim the
comment was about the ending.

**Regions, honestly.** A stored image region's locator reads *· Area* and
brings the image into view without drawing anything — never its top-left
corner passed off as a point. A moment with a region on its frame seeks to the
moment and draws nothing; the region stays in the projection and in history.
Both overlays remain deferred.

**History.** Each page's stage holds only that page's Revision, so a locator
can only reach the work its round was asked about: the client's current page
reaches the current version, *Previous versions → Version 2* reaches Version 2,
and Studio's Version 2 reaches Version 2. **Studio's presentation page shows
the draft**, so its locators are links instead —
`/studio/workrooms/{room}/presentations/{presentation}/revisions/{N}?note={n}`,
the existing Studio route plus the Revision's public number and the note's
ordinal (`revisionLocatorHref`). The target page parses `note` strictly
(`readNoteParam`) and looks it up in **its own** projection: a tombstone, an
item-level note, a number in another round, or nonsense opens nothing. That
Revision number comes from the staff panel (`StaffReviewPanel.revision`), so
it is the Revision whose round is on screen.

**Accessibility.** Locators are real buttons named by their own words, with
`aria-pressed`; a polite live region says what was shown (*Showing the point on
The board.*, *The motion, paused at 0:42.*); Escape clears; no focus is moved
while somebody is only reading.

**Tested.** `review-locator-navigation.test.ts` (the decisions, the Revision
number, the capture-copy gate, one `FileViewer`) and
`review-locator-browser.test.ts`, a real Chromium against a server sharing the
test database, with playable media (`tests/support/media.ts`: PNG and WAV
written byte by byte, one committed 8-second VP8 WebM). Three deliberately
broken builds — a cancelled wait that kept its listeners, smooth scrolling
under reduced motion, Escape ignored — each failed exactly the test written for
it, and a client Version 2 page rendering the current version's work failed the
history test.

**Still not built:** client anchor capture of any kind — image points, audio
and video moments and stretches, regions; video frame-region display; PDF
precision; signed-URL recovery (F6); Stage G. **F2 is not manually accepted on
beta** and cannot honestly be yet: nothing a person can reach creates a precise
anchor, and no backdoor was added to manufacture one. It becomes manually
testable end to end once capture exists. Stage F is not complete.

**Real-beta regression smoke after F2 deployed: passed.** Studio's Brand
Direction page rendered normally; the reorder controls were still correct;
historical Version 2 still rendered its frozen media and its Review intact —
comments, replies and *Dealt with* state — with the clean *Comment removed*
tombstone. That is a smoke test that nothing regressed, **not** acceptance of
precise anchors, which nothing on beta could create.

#### F3 — audio capture, built

**A client writing a new point about a recording may say exactly when.**
Choosing an audio block in *About* offers one quiet control, *Set precise
time*. It scrolls to **that** block — by position, so the second of two
recordings opens the second — and opens a small panel under its **native
player**, which is how the person gets to the place they mean: *Use this
moment*, or *Start here* and *End here*, then *Done* or *Cancel*. The panel
reads `currentTime` and `duration` and nothing else — no waveform, no
scrubber, no second player — and never plays anything.

**Optional means optional.** General feedback, item-level feedback about a
recording, a moment and a stretch are four ordinary ways to send a point.

**The rules are data** (`lib/workrooms/audio-capture.ts`, pure). Nothing can
be chosen until the file reports a finite duration, and the panel says so; a
time is rounded by F1's rule to the millisecond, never past the end, with no
ceiling of its own. An end at or before the start is refused with *Choose an
end after the start.* — never swapped — and the start is kept. Either end can
be pressed again.

**The draft.** *Done* keeps the choice in the unsent comment and returns
focus to the words, which then show *At 0:42* or *0:42–0:51* with *Change* and
*Clear*. *Cancel* — and Escape while choosing — keeps whatever the draft had
before: *Change* then *Cancel* gives the old time back. *Clear* removes only
the time. Switching to another block, or to the version as a whole, drops the
time without asking.

**Sent through the path that already existed.** The choice travels in the
root composer's own `anchor` field — `{"kind":"time","t":2.5}` — through
`createReviewNoteAction`, `readAnchor`, `parseReviewAnchor` and
`createReviewNote`. No new endpoint, no new write, no browser storage. The
server judges it from scratch: a stretch that ends first, a time on a picture
and a frame area on audio are all refused whatever the browser sent.

**Where it lives.** Eligibility is read from the frozen Revision the page
renders — `itemSubjects` marks a block whose snapshot viewer is `audio` — and
the capture session is one more context in F2's `ReviewStage`: opening it puts
away any locator's point, and pressing a locator cancels it. The panel renders
inside that block's `AnchorTarget`. Once sent, showing the time again is F2's
code, unchanged. Only the new-comment composer has it — not replies, not
corrections, not a closed or superseded round, not Studio.

**Phones.** Every control wraps at 390px with nothing overflowing, and the
capture buttons are 44px under a coarse pointer. Stretches are offered there
too; `RANGES_ON_COARSE_POINTERS` withholds them in one line if real-phone
acceptance finds the native player too coarse for two presses. No timeline
will be built to rescue them.

**Tested.** `audio-capture.test.ts` (the rules, and the real write path with
crafted refusals) and `review-capture-browser.test.ts` (15 flows in Chromium
at 1280px and 390px: both shapes stored exactly and found again by F2's
locator, invalid ends, Change/Cancel/Escape, Clear, switching subjects, two
recordings, a file still loading and one that fails, keyboard only, reduced
motion, nowhere it must not appear, and a precise comment taken back leaving
nothing of its time). Three deliberately broken builds — Cancel keeping the
new time, a time surviving a change of subject, video offered capture — each
failed the test written for it.

**Status: IMPLEMENTED · AUTOMATED TESTS PASS · REAL-BETA MANUAL ACCEPTANCE
PASS.**

**F3 is verified on beta.** Walked by hand on the real Railway beta deployment,
the client on a real iPhone, Studio on a desktop, on *Schick's Take Home
Foods.m4a* in the Presentation **Audio review test**, Version 2:

- **The M4A plays inline** in the native `<audio>` on the iPhone — the blocker
  the same walk had found earlier (`audio/x-m4a` missing from the viewer's exact
  list) is cleared.
- **The recording can be chosen as the subject**, and *Set precise time* opens
  its panel against that exact native player.
- **A moment**: captured at *0:01*; the composer kept *At 0:01*; the sent root
  kept its locator; the client's locator sought back to 0:01 and stayed paused;
  Studio received the same precise note, and Studio's locator opened the
  immutable Version 2, sought to 0:01 and stayed paused.
- **A stretch**: captured *0:01–0:02* with *Start here* / *End here*; **the range
  interaction was usable on the real iPhone**, so `RANGES_ON_COARSE_POINTERS`
  stays `true`; the composer kept *0:01–0:02*; the sent root kept its locator;
  the client's locator sought to 0:01 — the start — and stayed paused; Studio
  received the same stretch, and its locator opened the immutable Version 2,
  sought to 0:01 and stayed paused.
- **U.S. month-first New York dates** were visually accepted during the same
  walk.

The walk also exercised **F2's audio return-to-context** end to end, in both
worlds and across the draft-to-Revision link. F2's **image point** display has
not been walked on beta — nothing yet creates one.

**Still not built:** video capture, image point capture, regions, frame-region
display, PDF precision, signed-URL recovery (F6), Stage G. Stage F is not
complete.

## Reviews are verified on beta

Implementation D/E, exercised by hand on the real Railway beta deployment:
Studio on a desktop, the client signed in through the ordinary Workroom sign-in
on a real phone. Not Preview standing in for a client, and not a test harness
standing in for either. The Presentation was **Brand Direction**.

| | |
| --- | --- |
| **Request.** Studio showed *Nobody has been asked about this version yet.*; *Ask for feedback* opened the in-app `ConfirmDialog`, which said the client may write and no email is sent; confirming opened the round, *Close feedback* appeared, and *Take the request back* appeared while the round was empty | **passed** |
| **Client, open round.** The Feedback surface appeared only once asked for; *The studio asked for your thoughts on this version.* and the composer were shown; no Studio control was | **passed** |
| **General feedback.** Appeared at once for the client and in Studio with its author and time; Studio offered *Mark as dealt with* and *Reply*; *Take the request back* disappeared once feedback existed; the point count moved | **passed** |
| **Item-level feedback.** The client picked *Primary identity direction*; both surfaces read *On Primary identity direction* | **passed after fix A** |
| **Studio reply.** Nested one level, the studio's author snapshot and *Studio* marker and time; the client saw it after refreshing, and the root was untouched | **passed** |
| **Resolve and reopen.** *Mark as dealt with* confirmed in the centred dialog, saying the conversation stays visible; root and reply stayed in place under *Dealt with — Yiddi Weller*; the client saw it, reopened their own point, and the round was writable again with the conversation intact | **passed** |
| **Correct.** A fresh point — the earlier ones were outside the window — offered *Correct* and *Take back*; the inline editor loaded the original words with Save, Cancel and the helper text about the window and replies; *Could the spacing feel a little tighter?* became *…tighter overall?*; *Corrected* appeared and stayed after a refresh, while the momentary success line did not | **passed** |
| **Take back.** The dialog said the words would go, the studio could not read them either, that something was written stays on the record, and it cannot be undone; afterwards both worlds showed only *Comment removed* | **passed after fix B** |
| **Close.** The dialog said the conversation stays and the client can no longer add to it, reopenable while this is the current version. Studio: *Closed by the studio*, *Reopen feedback*, the whole thread, no per-note controls. Client: the whole thread, the closed line, and no composer, *Reply*, *Correct*, *Take back*, *Mark as dealt with* or *Not dealt with* | **passed** |
| **Reopen.** Studio: open again, *Close feedback* back, per-note controls back, thread intact. Client after refresh: the open-round line, the composer and the right actions back, the conversation and the tombstone intact | **passed** |
| **Publish over an open round.** The dialog now names the consequence before the press | **passed after fix C** |
| **Supersession.** Version 2's round, reopened, was ended by publishing Version 3. Studio's Version 2: frozen, *Closed when version 3 was published*, terminal, the whole thread — studio replies, the resolution, *Comment removed* — and no controls. The client's *Previous versions → Version 2*: the same thread, *Feedback on this version closed when version 3 was published.*, no composer and no actions | **passed** |
| **The new current version.** Beta has since moved on to Version 4, which the client is reading; Studio shows *Nobody has been asked about this version yet.* and offers *Ask for feedback* — a new Revision does not inherit the round before it | **passed** |

### Three defects the walk found

Each was invisible to every automated suite, each was fixed at its cause rather
than at the symptom, and each was retested on beta before this record was
written.

**A — the item locator.** Picking *Primary identity direction* did not produce
*On Primary identity direction* in Studio. A draft's positions are an ordering
key with gaps after a removal; a Revision's items were written densely by index
while its snapshot kept the draft's numbers, so one block had two numbers and the
Review path crossed between them. Fixed in `37a43ef`: one Revision position model,
dense, used by the snapshot and `presentation_revision_items` alike, with
Revisions frozen earlier renumbered on read rather than rewritten — see *One
number for a block*. Retested on beta with **new** item-level feedback: *On
Primary identity direction* on both surfaces, matching.

**The note already written during the failure was not rewritten.** Its stored
`revision_item_id` is what it is, and correcting beta test data by hand would
have been a rewrite of a Review record to make a defect look as if it never
happened. It stays as history of the defect.

**B — the tombstone.** A removed comment read *Yehuda Weller · 23 Sept, 20:44 ·
This was taken back.* `ReviewThread` drew the note's header before checking
`removed`, in both the root and the reply branch, and the projection kept an
author and a time on a removed note for it to draw. Fixed in `1f9c330`: a removed
note is structurally `{ n, removed: true }`, reading an author off one does not
compile, and it renders as `Comment removed` and nothing else. Retested on beta:
exactly *Comment removed* for the client and for Studio, with no author, time,
locator, resolution, edit state or control.

**C — the publish consequence.** About to publish over Version 2's open round,
the dialog said only *The client will see this instead of the current version.*
It never looked at the round. Fixed in `4af8c0c`: it names the version and, for
an open round and only an open round, adds *Feedback on Version 2 will close and
remain available as read-only history.* No round, a staff-closed round and a
withdrawn round say nothing about feedback, because publishing changes none of
them. The publish transaction was not changed.

### What this acceptance does not cover

Precise anchors — points, regions, time ranges — are stored, validated and
projected but not drawn by anything; that interaction is **Stage F**. Nobody is
told by email or otherwise that a round was opened or answered; that is **Stage
G**. Approvals has not begun. None of the three is implied by the table above.

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
presentation_reviews        FK (workroom_id, closed_by_revision_id)    →  presentation_revisions
presentation_review_notes   FK (workroom_id, presentation_review_id,
                                presentation_revision_id)              →  presentation_reviews
presentation_review_notes   FK (workroom_id, presentation_revision_id,
                                revision_item_id)                      →  presentation_revision_items
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
ClientPresentation  { id, title, intro, publishedAt, revision, items[], revisions[] }
ClientRevisionRef   { number, publishedAt, current }
ClientRevisionItem  { id, kind, caption, body?, file? }
ClientReview        { status, requestedAt, canWrite, closedNote?, notes[] }
ClientReviewNote    { n, author, at, body?, removed, edited, anchor?, resolved, replies[] }
ClientApproval      { id, status, requestedAt, decidedAt?, decidedBy?, declineReason? }
```

**Deliberately absent, and never fetched on a client request:** `storage_key`,
`preview_key`, `storage_etag`, `original_filename`, raw `content_type` (a coarse
`kind` of `image | pdf | video | document | other` instead), raw byte counts
(formatted server-side), `uploaded_by`, every internal id, every `internal` file,
every draft Presentation, every draft item, every `notes` field anywhere, every
`audit_events` row, and every other Workroom's anything.

`revisions[]` is the `Previous versions` control's whole data source, and it is
deliberately two facts and a flag: **a number and a date say which version and
when, and nothing about what changed.** No diff summary, no "3 items added", no
publisher's name — a client reading a changelog of the studio's second thoughts
is not the product.

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
| *Unshare* a file in a Revision of a `published` Presentation | **Refused**, naming the Presentation. Not archive, but the same reason | n/a |
| Draft Presentation | Owner | No |
| Presentation with any Revision | Owner | No |
| Presentation with a decided Revision | **Refused**, naming the decision | No |
| Revision, revision item | Never. Immutable | Never |
| Review round, review note | Never. **Refused by trigger**, as is TRUNCATE | Never |
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
| Request feedback; close, withdraw or reopen a round | ✓ | ✓ | — | — | — |
| **Open a feedback item** | **—** | **—** | **✓** | — | — |
| Reply to one | ✓ | ✓ | ✓ | — | — |
| Resolve or reopen **any** feedback item | ✓ | ✓ | — | — | — |
| Resolve or reopen **their own** | ✓ | ✓ | ✓ | — | — |
| Edit or remove **their own**, inside the window | ✓ | ✓ | ✓ | — | — |
| Request approval | ✓ | ✓ | — | — | — |
| **Grant / decline approval** | — | — | **✓** | — | — |
| Withdraw approval request | ✓ | ✓ | — | — | — |
| See archived delivery content | ✓ | ✓ read-only | — | — | — |

Three rows deserve naming.

**Staff cannot approve.** An approval is the client's decision; a studio able to
record one on their behalf has built a forgery tool.

**Staff cannot open a feedback item**, enforced by a CHECK rather than by a
guard. The round is the client's voice; the studio's contribution is replies,
resolutions and the next Revision. A studio able to raise items on its own work
has built a shared to-do list, not a review.

**Nobody removes anybody else's words**, staff included. Removal is the
author's, inside fifteen minutes, before any reply — and it is a tombstone, so
nothing is erased either.

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
| Malicious MIME | The stored `content_type` is matched **exactly** against a closed five-outcome map, never by prefix and never from the request. An unlisted type has no inline address at all: the view route refuses before it signs. Everything, without exception, also downloads as an attachment |
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
- **Render inline only** the five outcomes of `viewerKind()` — raster images,
  PDF, `video/mp4|webm|ogg`, and the browser-native audio types. The exact
  list, and why it is exact matches rather than prefixes, is in *The viewer*.
- **Refuse outright** only the genuinely hostile: `.exe`, `.dll`, `.bat`,
  `.cmd`, `.sh`, `.msi`, `.app`, `.scr`, and anything declaring `text/html`.
- **`image/svg+xml` is accepted, never rendered inline, never previewed.**

**No Presentation ZIP download in Build 005.** It would mean server-side
archiving of files that otherwise never touch our process, which is the one
thing this storage design avoids.

---

## Migration shape

Three migrations now: `0004_delivery.sql`, `0005_delivery_integrity.sql` and
`0006_reviews.sql`. The first two are **additive throughout** — no column is
dropped, renamed or retyped anywhere in Builds 001–005. **`0006` is not**, and
that is recorded rather than glossed: see below.

`0004` was generated then extended by hand as `0003` was.

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

### `0006_reviews.sql` — corrective, and the window that made it free

**It drops eight columns**, the whole one-response model `0004` shipped:
`revision_item_id`, `response_body`, `responded_at`,
`responded_by_identity_id`, `responded_by_name`, `resolution_note`,
`resolved_at`, `resolved_by`, with their CHECKs, their foreign keys and both
partial unique indexes.

That is a departure from the additive rule, and the justification is narrow and
checkable rather than a matter of taste: **`presentation_reviews` has never held
a row.** No code outside two test-cleanup lines referenced it, beta's copy was
empty, and production does not have the table at all — production is Build 004
and `0004` has never run there. So this corrects a table before it goes live
rather than migrating data.

**The assumption is a guard, not a belief.** The migration opens with a `DO`
block that raises if `presentation_reviews` holds a single row, so the day that
stops being true it refuses to run instead of destroying something. That was
tested by seeding a row and watching it refuse, with `response_body` still
standing afterwards.

**The window closes at promotion, or at the first real beta row**, whichever
comes first. After that the same change becomes a genuine data migration.

Contents:

- One `CREATE TABLE`, `presentation_review_notes`, with its indexes, three
  unique keys and fourteen CHECKs
- `UNIQUE (workroom_id, presentation_revision_id, id)` added to
  `presentation_revision_items` **purely as a foreign-key target** — the one
  statement that touches a table already holding real Stage B rows on beta
- The `presentation_reviews` rewrite above, plus five new columns and
  `UNIQUE (presentation_revision_id)`
- A lifecycle trigger on `presentation_reviews`: identity immutable, the
  permitted transitions and nothing else, a supersession unrewritable in one
  write or two, and `DELETE` and `TRUNCATE` refused
- A guard trigger on `presentation_review_notes`: identity, subject and
  authorship immutable; the body correctable for fifteen minutes and then
  never; removal only inside that window and never undone; `DELETE` and
  `TRUNCATE` refused
- `bump_version()` on the notes table

**Statement order is hand-set, not generated.** Unique constraints must exist
before the foreign keys that target them, and `drizzle-kit` emits additions in
its own order — the first run failed on exactly that. The file is one
`0006_reviews.sql` with a machine-accurate snapshot; `npx drizzle-kit generate`
reports *no schema changes*, which is how the ORM and the migration are proven
not to have drifted.

**Rehearsed on both paths before anything read it**, as `0005` was:

| Path | Result |
| --- | --- |
| Build 004 schema → `0004` → `0005` → `0006`, with real Build 004 rows | Every row preserved; fingerprint identical before and after |
| A Stage B database at `0005` holding real Presentations and Revisions → `0006` | Every Revision, revision item and content hash identical |
| Both, compared against a database built from scratch through the whole chain | **Byte-identical schema dumps**, all three |

**Build 004 code tolerates the Build 005 schema.** Everything is a new table or
a widened constraint; no existing insert becomes invalid. A code rollback
without a schema rollback is safe — the property Build 004 proved by direct test
and Build 005 must prove the same way.

**Rehearsal before promotion:** rebuild a Build 004-shaped database with
realistic volumes, apply `0004`, assert row-for-row data identity, diff
`pg_dump --schema-only` against a from-scratch build to zero, then run the
**full suite against the migrated database**.

### `0005_delivery_integrity.sql` — three gaps, closed

`0004` created the Presentation tables in Stage A so the model could be reasoned
about whole. Reading them again against the benchmark found three places where
the schema trusted the application where it could have made PostgreSQL refuse.
**`0005` closed all three, and it was applied before the first line of
Presentation domain code was written** — retrofitting an integrity constraint
after rows exist is how a constraint gets weakened to fit the data.

It is additive: two `ADD CONSTRAINT`, one `ADD CONSTRAINT` on a unique key, and
one CHECK replaced. Rehearsed on both paths — a Build 004 database through
`0004` and `0005`, and a Stage A database that already held Presentation rows
through `0005` alone. Every row survived both, and the upgraded schema is
byte-identical to one built from scratch.

**1. `presentations.current_revision_id` has no foreign key at all.** Not to
`presentation_revisions`, not to anything. Today it is an unconstrained `uuid`
that could name another Presentation's Revision, another Workroom's Revision, or
a row that does not exist — in an architecture whose whole thesis is that the
database refuses rather than the code remembering. The fix binds it to the
Presentation it belongs to, not merely to the table:

```sql
ALTER TABLE presentation_revisions
  ADD CONSTRAINT presentation_revisions_presentation_id_id_key
  UNIQUE (presentation_id, id);

ALTER TABLE presentations
  ADD CONSTRAINT presentations_current_revision_fk
  FOREIGN KEY (id, current_revision_id)
  REFERENCES presentation_revisions (presentation_id, id);
```

The circularity is only apparent: the column is nullable, so a Presentation is
created with it `NULL`, its first Revision is inserted, and the `UPDATE` closes
the loop. No deferral needed.

**2. Nothing ties `status = 'published'` to actually having something to show.**
A row may claim `published` with `current_revision_id` and `published_at` both
`NULL`, which renders an empty page to a client. A CHECK says it properly:

```sql
ALTER TABLE presentations ADD CONSTRAINT presentations_published_shape_check
  CHECK ((status = 'published' AND current_revision_id IS NOT NULL AND published_at IS NOT NULL)
      OR (status <> 'published'));
```

**3. `presentation_revision_items.display_name_snapshot` is unconstrained.** A
`note` may carry one and a `file` may omit one, so the column that exists to
prove what name the client read can be absent on exactly the rows that need it.
It belongs in the shape check beside `file_id` and `body`.

None of the three was reachable by the code that existed, because nothing read
or wrote these tables yet. That was the whole reason to fix them then. Each is
tested directly against PostgreSQL rather than through the domain: a
Presentation naming another Presentation's Revision, a `published` row with
nothing to show, and a file revision item with no snapshotted name are all
refused by the database with the code removed from the question.

### Review uniqueness, and the NULL semantics that used to matter

`0004` allowed an open review to be revision-level (`revision_item_id IS NULL`)
or item-level, and used **two partial unique indexes** rather than one, because
a conventional unique index treats NULLs as **distinct** — so a single index on
`(presentation_revision_id, revision_item_id)` would have permitted unlimited
revision-level reviews, the exact case it existed to prevent.

**`0006` drops both.** Item-level *requests* are withdrawn: the studio asks
about the delivery, and precision belongs to the feedback rather than to the
ask. What replaces them is simpler and stronger — `UNIQUE
(presentation_revision_id)`, no predicate, no nullable column, *one round per
Revision, ever*.

The technique is kept here because the next nullable uniqueness question will
look identical, and because the reasoning outlived the rule: PostgreSQL 16 also
offers `NULLS NOT DISTINCT`, and two partial indexes were still preferred for
saying what they mean at the point of definition rather than depending on a
server-version feature being remembered.

**A second NULL trap, found while writing `0006`, and worth more attention than
the first.** A CHECK constraint passes when its expression evaluates to NULL —
only an outright `false` is a violation. The closure rule was first written as
`(status = 'closed' AND … closed_reason IN ('staff','superseded') …) OR (status
<> 'closed' AND …)`. For a row claiming `closed` with no reason, `NULL IN (…)`
is NULL, so the first branch is NULL, the second is false, and `NULL OR false`
is NULL — **the constraint accepted the exact row it was written to refuse.** It
is now a `CASE`, where every branch returns a real boolean. A test asserting
against PostgreSQL caught it; reading the expression had not.

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

Chat. Slack-style comments. Client uploads. Folders or
collections. Server-side media processing. PDF rasterization. Video transcoding.
Presentation ZIP downloads. Workroom member roles. `presentation.viewed`
tracking. A notification centre. Public file sharing. External anonymous
approvals. Per-file roles. A Dropbox replacement. A DAM. Invoicing, payments,
contracts or e-signatures — those are Build 006. Inbound email — Build 007.

Also refused inside Reviews, each deliberately: @mentions, reactions, labels,
assignments, due dates, reviewer groups, a private internal comment lane,
comment export, live synchronised review, custom review statuses, anonymous
reviewers, staff-authored feedback items, and carrying feedback forward to a
later Revision.

**Threaded review replies were on this list and are not any more.** They are
built into `0006`, bounded to depth one by a foreign key. The reversal and its
evidence are under *Reviews*.

Each of these was considered against the blueprint and excluded on purpose, not
forgotten.
