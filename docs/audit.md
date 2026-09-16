# Audit

Who changed what, and when. Introduced in Build 003, the first build holding
material business data, because an audit trail added afterwards can only record
what happened after it.

---

## Audit is not activity

This distinction is permanent and the two must never become one table.

| | **Audit** | **Activity** — built in Build 004 |
| --- | --- | --- |
| Answers | Who changed what, when? | What happened around this Client or Project? |
| Read by | Owners, rarely, deliberately | The team, and sometimes the client |
| Mutable | **Never.** Append-only. | Filtered, softened, hidden |
| Examples | `client.archived`, `lead.converted`, `staff.deactivated` | `workroom.opened`, `presentation.published`, `approval.decided` |
| Retention | A compliance decision | A product decision |

The Activity column read "later" and gave *a presentation viewed, an approval
submitted, an invoice opened* until Build 005 planning replaced it with the real
vocabulary. Activity exists — `workroom_activity`, since Build 004 — and **a
presentation viewed is not in it**, deliberately: see the note under *Reading
it* below, and [`delivery.md`](./delivery.md).

Merged, they produce either a feed full of security noise or an audit trail
somebody can edit. `audit_events` is **not** the future client-facing activity
feed, and no future build may repurpose it as one.

---

## What a row holds

| Column | Notes |
| --- | --- |
| `id` | UUIDv7. |
| `occurred_at` | `timestamptz`, UTC. |
| `actor_type` | `team_user`, `client_user` or `anonymous_session`. Defaults to `team_user`, which is what every event written before Build 004 was. |
| `actor_id` | The staff member, nullable. `SET NULL` if they are ever removed. |
| `client_actor_id` | The client identity, when a client caused it. A second column rather than a widening of `actor_id`, because a client is a row in a different table and a schema that pretended otherwise would be the first place that rule broke. A `CHECK` refuses a row that claims one kind and carries the other. |
| `actor_name` | A snapshot of their name, so history stays readable afterwards. |
| `action` | `noun.verb_past_tense` — `lead.stage_changed`. |
| `entity_type` | Build 003: `client`, `contact`, `lead`, `project`, `client_contact`, `project_contact`, `inquiry`, `staff`. Build 004 added `workroom`, `workroom_member`, `workroom_invitation`, `client_identity`. A CHECK constraint holds the list; widening it is a migration. |
| `entity_id` | `text`, not `uuid`: business records use UUIDs, Better Auth's staff ids are strings, and both need recording. |
| `entity_label` | A safe human label — a Client's name, a Lead's title. Never a note or a message. |
| `metadata` | `jsonb`, structured, small, deliberate. |

No foreign key to the entity. Audit outlives what it describes; a key would
turn a deletion into an integrity error or, worse, cascade the history away.

---

## What is recorded

Every state change that a person would want explained later:

```
client.created    client.updated    client.archived    client.restored
contact.created   contact.updated   contact.archived   contact.restored
client_contact.added      client_contact.updated      client_contact.removed
lead.created      lead.updated      lead.archived      lead.restored
lead.stage_changed        lead.won        lead.lost      lead.converted
project.created   project.updated   project.archived   project.restored
project.status_changed
project_contact.added     project_contact.updated     project_contact.removed
```

**No history is fabricated.** Build 001 and Build 002 records exist and have no
audit rows, and none will be invented for them. The trail begins where the
system does.

---

## Privacy

Audit records *that* something changed, not a second copy of everything.

**Never written to an audit row:** authentication tokens, magic links, session
identifiers, secrets, inquiry message bodies, internal notes, descriptions, or
any long free text. Those live in their own table, under their own access
control, and copying them into a permanent append-only log doubles the exposure
and can never be undone.

For an ordinary edit, the metadata is the *names of the fields that changed* —
not their values:

```json
{ "fields": ["name", "website"] }
```

For a workflow change, the values are the point, and they are short and safe:

```json
{ "from": "discovery", "to": "proposal" }
```

For a relationship, the ids and whether it is primary:

```json
{ "client_id": "0199…", "contact_id": "0199…", "is_primary": true }
```

`entity_label` carries a name so the log reads in sentences rather than UUIDs.
A name is already visible to everyone who can read the log, so it adds no
exposure — a note or a message would.

---

## Append-only, enforced by the database

The application has no code path that updates or deletes an audit row: the
module exposes `record()` and readers, and nothing else.

That is not enough on its own, so PostgreSQL enforces it. A trigger raises an
exception on `UPDATE` or `DELETE` against `audit_events`, so a stray statement —
from a future bug, a console, or a well-meant cleanup — fails loudly instead of
quietly rewriting history.

```sql
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_mutation();
```

A row trigger alone still leaves one door open: `TRUNCATE` does not fire one, so
the whole log could be erased in a single statement. A second trigger closes it.

```sql
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_mutation();
```

All three are tested: the suite attempts an update, a delete and a truncate, and
asserts each is refused by PostgreSQL with the reason it gives.

The tests that need a clean log between cases disable the truncate trigger by
name, truncate, and enable it again — deliberately, visibly, in one helper. That
is the point: clearing this table is possible only as a stated act by somebody
who owns it, never as a side effect of ordinary code.

---

## History makes its actors undeletable

A consequence worth knowing, because it is stronger than the schema says.

Both actor columns declare `ON DELETE SET NULL`. That `SET NULL` is an `UPDATE`
of `audit_events`, and the append-only trigger refuses it — so deleting a staff
member or a client identity that appears in the log **fails** rather than
quietly blanking their name out of it.

Nothing in the product ever deletes a person: staff are deactivated and client
identities are disabled, both of which keep the row. So in practice this only
ever catches a mistake, and catching it is the right outcome: an actor cannot be
erased from the record of what they did.

---

## Written in the same transaction

A business change and its audit row are written together. If the change rolls
back, so does the record of it; if the audit write fails, the change does not
land. They cannot drift apart, which is the only way a log stays trustworthy
under failure.

That is why `record()` accepts the transaction it should run inside rather than
opening its own.

---

## Reading it

Studio → **Audit**, Owner only. A Member receives the same concealed
not-found response as any other Owner-only surface, per
[`studio.md`](./studio.md).

Filterable by actor, entity type and action, paginated, and written as sentences
rather than raw JSON. It reads as a record, not as a feed — a deliberate
difference from the Activity surface that arrives later.

Client actions appear here with their own attribution: a client accepting an
invitation is `workroom_invitation.accepted` by a `client_user`, and the Audit
page marks it. **A client opening a Workroom writes nothing** — audit records
what changes who can reach what, not who looked at what, and a page-view log
would turn an accountability record into traffic. **The same rule covers a
client opening a Presentation**, which is why Build 005 has no
`presentation.viewed` in either table; see [`delivery.md`](./delivery.md).

Each record also carries its own history on its page, under **History**, for
Owners only. It is the same data, scoped to one entity, and it is not fetched at
all for anybody else rather than fetched and hidden in markup that ships either
way.

---

## What Build 005 adds

Planned in [`delivery.md`](./delivery.md), **not written until Build 005 is
built**. Entity types `workroom_file`, `presentation`, `presentation_revision`,
`presentation_review` and `presentation_approval`, and these actions:

```
file.uploaded  file.renamed  file.shared  file.unshared  file.replaced
file.archived  file.restored
presentation.created  presentation.updated  presentation.published
presentation.unpublished  presentation.archived  presentation.restored
review.requested  review.responded  review.resolved  review.withdrawn
approval.requested  approval.granted  approval.declined  approval.withdrawn
```

Three are client-caused — `review.responded`, `approval.granted`,
`approval.declined` — and carry `actor_type = 'client_user'` with
`client_actor_id` set. The shape CHECK makes it structurally impossible to file
a client under the staff foreign key.

**The approval record itself is not audit.** `presentation_approvals` is a
business record whose *content* matters: which revision, which person, what
reason. Audit says an approval happened; it never says what it said. That is
this document's whole rule, applied to the first object that tests it.
