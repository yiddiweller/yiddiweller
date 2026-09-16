# Business core

The domain model Studio runs on, introduced in Build 003. Clients, Contacts,
Leads and Projects, and the rules that connect them.

Written before the schema, and reviewed against the situations at the end of
this file before a single migration was generated. Where a rule here is marked
**invariant**, the database enforces it — not the interface, and not a comment.

Audit is in [`audit.md`](./audit.md); the interface system is in
[`studio-design.md`](./studio-design.md).

---

## Four concepts, never blurred

```
INQUIRY ──▶ LEAD ──▶ CLIENT ──▶ PROJECT
   │          │         │          │
   │          └─▶ CONTACT ◀────────┘
   │                (people)
   └─ stays exactly as it arrived
```

| Concept | Is | Is not |
| --- | --- | --- |
| **Contact** | A person. | A client. A login. A profile. |
| **Client** | The business relationship — an organization or an individual Yiddi Weller works for. | A person. One is the account, the other is who you speak to. |
| **Lead** | An opportunity. It stays the record of that opportunity after it is won or lost. | A person, a client, or a project. |
| **Project** | Work performed for a Client. | A workroom, a task list, or a folder of files — those are Build 004 and 005. |
| **Inquiry** | The original intake record from the public contact form. | A lead. It becomes the *source* of one, and is never edited to say so. |

**One table never means two concepts.** That separation is what makes
workrooms, files, invoices, communication and reporting possible later without
a migration that untangles them.

---

## Clients

The account. `account_type` is `organization` or `individual`, because a
private client is still a relationship rather than a person — and when that
individual is also someone you speak to, they appear as a Contact linked to
their own Client.

| Field | Notes |
| --- | --- |
| `account_type` | `organization` \| `individual`. |
| `name` | Required. Not globally unique — two businesses can share a name. |
| `website` | Optional, as typed. |
| `domain` | Normalized from the website (`example.com`), for duplicate detection only. |
| `status` | `active` \| `inactive` — the state of the relationship, not of the record. |
| `notes` | Plain text, internal. |
| `archived_at` | Null while live. |

**No billing address, tax id, payment method or invoice preference.** Those are
Build 006 and adding them now would guess at a model nobody has designed.

---

## Contacts

A person, who may exist long before any relationship does — a referral source,
someone met at a talk, a prospect who never becomes a client.

| Field | Notes |
| --- | --- |
| `name` | Required. |
| `email` | Optional, as typed. |
| `email_normalized` | Lowercased and trimmed, for duplicate detection. **Not unique.** |
| `phone`, `title` | Optional. |
| `notes` | Plain text, internal. |
| `archived_at` | Null while live. |

**Email is deliberately not globally unique.** Two people share an office
address; a family shares one; an import will eventually arrive with duplicates
and incomplete rows. A unique constraint turns each of those into a failed save
with no way forward. Instead: normalize, detect an exact match, and *warn*
before creating a second person with the same address. The person deciding is
better placed than the constraint.

Nothing merges automatically. Merging is not in Build 003 at all.

---

## Client ↔ Contact

A relationship table, not a column on Contact. A Contact at an agency may act
for two Clients; a column would make that unrepresentable and the fix would be a
migration during a busy week.

| Field | Notes |
| --- | --- |
| `client_id`, `contact_id` | The pair. |
| `role` | Free text: "Marketing director", "Signatory". |
| `is_primary` | At most one per Client. |

- **Invariant:** unique `(client_id, contact_id)` — the same person cannot be
  attached to the same Client twice.
- **Invariant:** at most one primary Contact per Client, enforced by a partial
  unique index rather than by application care.

---

## Leads

The opportunity. It survives its own outcome: a lost Lead from two years ago is
why you remember the conversation.

| Field | Notes |
| --- | --- |
| `title` | What the opportunity is. Required. |
| `stage` | `new` → `discovery` → `proposal` → `won` \| `lost`. |
| `source` | `inquiry` \| `referral` \| `existing_client` \| `manual` \| `other`. |
| `inquiry_id` | The originating inquiry, when there is one. |
| `contact_id` | The person, when known. |
| `client_id` | The Client — set from the start for repeat work, or set by conversion. |
| `prospect_name` | An organization's name before it is a Client. |
| `summary`, `next_step` | Plain text. |
| `follow_up_at` | When to come back to it. |
| `owner_id` | The staff member responsible. **Ownership, not permission.** |
| `lost_reason`, `lost_at`, `won_at` | Outcome. |
| `project_id`, `converted_at` | What the conversion produced. |
| `archived_at` | Null while live. |

- **Invariant:** at most one Lead per inquiry — a partial unique index on
  `inquiry_id`. Two people clicking "Create lead" on the same inquiry produce
  one Lead, not two.
- **Invariant:** a Lead may only be converted once — `converted_at` is set
  inside the conversion transaction and the operation refuses if it is already
  set.

**One `client_id`, not two.** An earlier draft had `client_id` for repeat work
and `converted_client_id` for the conversion result, which is two columns
meaning "the Client this opportunity belongs to". The Lead's `source` already
records whether the relationship pre-existed, and audit records the moment it
was attached.

**No value, probability or forecast fields.** A CRM would have them; Yiddi
Weller does not need them yet, and money belongs to Build 006 where it can be
modelled properly in minor units with a currency.

---

## Projects

Work for a Client. Every Project has one — that is the point of a Project.

| Field | Notes |
| --- | --- |
| `client_id` | **Required.** |
| `lead_id` | The opportunity it came from, when there was one. |
| `name`, `description`, `notes` | Plain text. |
| `status` | `planned` \| `active` \| `on_hold` \| `completed` \| `cancelled`. |
| `owner_id` | Responsible staff member. |
| `starts_on`, `target_on` | Dates, not timestamps: a project starts on a day. |
| `archived_at` | Null while live. |

Contacts attach through `project_contacts`, with the same shape and the same
two invariants as Client ↔ Contact: one row per pair, at most one primary.

**No files, presentations, approvals, phases or tasks.** Build 005 — and the
reason nothing here is a JSON attachment blob is that they attach as real rows
with real foreign keys.

**Corrected 2026-09-16:** this sentence used to say they attach *to a Project*.
It was written before Workrooms existed. They attach to **`workrooms.id`**, the
client-facing container Build 004 introduced, because that is the authorization
boundary: hanging a client-visible file off an internal Project record would put
that record in the middle of every client read and add a hop to the chain for
nothing. [`blueprint.md`](./blueprint.md) and [`workrooms.md`](./workrooms.md)
already said `workrooms.id`; this file was the outlier. The model is
[`delivery.md`](./delivery.md).

A Project still reaches them, one join away through its Workroom — which is the
same relationship the Workroom itself has to the Client, and for the same
reason.

---

## Inquiries stay exactly as they arrived

The `inquiries` table is production data from Build 001 and Build 003 does not
touch its shape.

Creating a Lead from an inquiry is a deliberate act by a person, not an
automatic conversion. The inquiry is never edited, never deleted, and never
marked "processed" by a boolean — **the relationship is the truth**:

> An **unprocessed inquiry** is an inquiry with no Lead pointing at it.

A duplicated `processed` flag would be a second source of truth, and the two
would eventually disagree.

### The flow

1. Someone opens the inquiry and chooses **Create lead**.
2. Studio shows the name, address and message as they arrived.
3. It looks for a Contact with the same normalized email and offers to reuse it.
4. Otherwise it offers to create a Contact from the confirmed details.
5. Contact (reused or created), Lead, and the link to the inquiry are written
   **in one transaction**, with the audit event.
6. Any failure rolls all of it back. There is no half-created person.

**Including the failure that is not an error.** Two people pressing at the same
moment both reach the "we do not know this person" branch and both insert a
Contact; only one wins the unique index on `inquiry_id`. The loser therefore
throws rather than returning, so its Contact goes back too — otherwise one press
each would leave the same person in the table twice. The caller is then sent to
the Lead that exists, which is what they wanted. This was measured, not assumed:
asserting the contact count is what found it.

---

## Winning a Lead

Changing a label is not a conversion. Winning asks what actually happened:

- an existing Client, or a new one to create;
- the Contact to attach, reused or created;
- optionally a Project, with an owner.

Won is therefore not one of the stages anybody can move a Lead to by hand. The
stage control offers the others; winning is what converting does. A Lead marked
won with nothing behind it is a claim the rest of the system cannot see.

All of it — Client, Client ↔ Contact, Project, Project ↔ Contact, the Lead's
stage and `won_at`, `client_id`, `project_id`, `converted_at`, and the audit
events — is **one transaction**. A Client created while the Project failed,
with a Lead that says Won, is the failure mode this exists to prevent.

It is **idempotent**: the claim on the Lead requires `converted_at` to still be
null, so a double submission or a retried request cannot produce two Clients.
The losing attempt does not merely stop — it throws, which rolls its whole
transaction back, so nothing it had already inserted survives.

That guard is `converted_at` rather than `project_id` precisely because a Lead
can be won without one.

A **lost** Lead keeps its reason and its timestamp, stays in the list behind a
filter, and is never deleted.

---

## Assignment is not authorization

`owner_id` on a Lead or a Project says who is responsible. It says nothing about
who may see it.

In Build 003 every active staff member can see the whole business core. A record
does not disappear because a colleague owns it — a studio of this size needs to
cover for each other, and hidden records make that impossible. If granular
permissions ever arrive, they will be a separate system, and this sentence is
here so nobody mistakes ownership for one.

| | Owner | Member |
| --- | --- | --- |
| See everything in the business core | ✓ | ✓ |
| Create and edit Clients, Contacts, Leads, Projects | ✓ | ✓ |
| Move a Lead's stage, convert a Lead | ✓ | ✓ |
| Manage relationships | ✓ | ✓ |
| **Archive and restore** | ✓ | — |
| **Audit log** | ✓ | — |
| Team and invitations | ✓ | — |

Archive and restore are Owner-only because they are the lifecycle actions that
remove things from everyone else's view. Members do the day's work; taking a
record out of circulation is a decision with a name on it.

---

## Archive, not delete

Nothing in the business core is deleted through the interface. `archived_at`
marks a record as out of circulation: relationships survive, audit survives, and
it can be brought back.

Guards, because an archive that creates nonsense is worse than a refusal:

| Attempt | Result |
| --- | --- |
| Archive a Client with live Projects | **Refused**, naming them. Archive or finish the Projects first. |
| Archive a Contact who is primary for a live Client or Project | **Refused**, naming them. Reassign the primary first. |
| Restore a Project whose Client is archived | **Refused.** Restore the Client first. |
| Archive anything already archived | No-op. |

A "live" Project is one that is not archived and not `completed` or
`cancelled`.

Permanent deletion is not a product feature. If a row ever has to go — a legal
erasure request — it is a deliberate operation against the database, recorded,
and outside this interface.

---

## Concurrency

Studio is multi-user now. Every update of a core record carries the `version`
the editor loaded, and the statement only applies if the row still has it. If it
does not, nothing is written and the person is told the record changed while
they were editing it, calmly, with the chance to reload.

**It is an integer, not `updated_at`, and that was a correction.** The first
design compared the timestamp — and it never matched. PostgreSQL keeps
`timestamptz` to the microsecond and a JavaScript `Date` only to the
millisecond, so the value the application reads back is never the value the row
holds, and every save would have been refused as a conflict. An integer survives
the round trip exactly.

A `bump_version` trigger raises it on every `UPDATE` of all six business tables,
so it cannot be forgotten by a query, and cannot be faked by one either: a
statement that sets `version` itself is overwritten by the trigger.

One helper — `expectUnchanged` in `lib/db/outcome.ts` — turns "no rows affected"
into the refusal for every entity. The failure mode it prevents, two people
editing a Client and the second silently erasing the first's work, is the kind
of bug nobody reports because nobody sees it happen.

---

## Search

One server-side search across Clients, Contacts, Leads and Projects, using
PostgreSQL. Case-insensitive prefix and substring matching on the fields a
person actually remembers: a Client's name, a Contact's name or address, a
Lead's title or prospect, a Project's name.

Four small indexed queries run together rather than one union the planner would
have to guess at, bounded to five results per kind so one busy table cannot
crowd the others out. Authorized like every other read, and never leaving the
server. No external search service — the data is client information, and at this
scale Postgres is not the bottleneck. Everything is in `lib/db/search.ts`, so it
can become `tsvector` or trigram-indexed later without touching a page.

A search of one character returns nothing rather than everything, and `%` and
`_` are escaped: somebody typing them means the characters.

---

## Reviewed against real situations

Every one of these was walked through the model before the migration was
written.

| Situation | How the model holds it |
| --- | --- |
| **A new prospect writes in** | Inquiry → Contact + Lead (`source: inquiry`, `inquiry_id` set, no Client). |
| **An individual client** | Client with `account_type: individual`, plus a Contact for the same human, linked as primary. The account and the person stay distinct. |
| **An organization client** | Client `organization`, several Contacts, one primary. |
| **Repeat work from an existing Client** | Lead with `client_id` set and `source: existing_client`. Conversion creates a Project, not a second Client. |
| **A contact who acts for two clients** | Two `client_contacts` rows. Primary for one, not the other. |
| **A Lead won without a Project** | Client attached, `won_at` and `converted_at` set, `project_id` null. Perfectly valid. |
| **A Lead won with a Project** | Both, in one transaction. |
| **A Lead lost** | `lost_reason`, `lost_at`, stays visible behind a filter for ever. |
| **A Contact leaves the company** | Archive the Contact. Refused while they are a primary, so the gap is noticed rather than discovered later. |
| **A Client relationship ends** | `status: inactive` while work finishes; archive once nothing is live. |
| **A staff member is deactivated** | Their Leads and Projects keep `owner_id` — history stays readable. Their Studio access ends immediately, as in Build 002. Reassignment is an ordinary edit. |
| **Build 004 workrooms** | Attach to `projects.id` and `clients.id`, both stable UUIDs. No migration gymnastics. |
| **Build 005 delivery** | Files, presentations, reviews and approvals attach to `workrooms.id`, not to a Project. A Workroom is the authorization boundary; a Project is the internal record. See [`delivery.md`](./delivery.md). |
| **Build 006 money** | Invoices reference `clients.id` and `projects.id`. Nothing financial is squatting in those rows now. |
| **Build 007 communications** | Messages reference `contacts.id`, and a Contact is already one canonical person rather than a copy inside each Client. |

---

## Known limitations

Recorded plainly, because a model remembered as more complete than it is costs
more later than one whose edges are written down.

- **No merging.** Two records for the same person or company are found by the
  duplicate warnings and resolved by hand. Merging is not in Build 003.
- **Search is substring, not full text.** `ILIKE` over `lower()` indexes, five
  results per kind. It does not rank by relevance, spell-correct, or match
  across words. `lib/db/search.ts` is where that becomes `tsvector` when the
  data is big enough to need it.
- **Every active staff member sees everything.** Ownership is not authorization,
  and per-record permissions are not built.
- **No value, probability or forecast on a lead.** Money is Build 006.
- **Archiving is reversible but not cascading.** Archiving a Client leaves its
  Contacts and archived Projects where they are, deliberately: they belong to
  more than one thing.
- **A Contact's relationship to a Project is not shown on the Contact's own
  page.** Their Clients and Leads are. Adding it is a query, not a model change.

---

## Acceptance

Build 003 passed manual acceptance on the Railway beta environment on
2026-09-15 — navigation, all four modules, inquiry → Lead, the pipeline,
conversion, relationships, audit and archive protection, plus an end-to-end
business workflow — and was then promoted and **verified in production the same
day**, where every one of those was exercised again against the live service.

**This model is now load-bearing.** It describes records that exist, belonging
to real clients. Changing a rule here is a migration and a decision, not a
refactor.

The model represents all of them without a workaround, which is why it was
built this way rather than as four CRUD tables that happen to have foreign keys.
