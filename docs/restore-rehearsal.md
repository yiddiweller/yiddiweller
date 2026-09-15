# Restore rehearsal

The procedure for proving that production PostgreSQL can actually be restored.

**Performed on 2026-09-15. Production restore is no longer a hypothesis.** What
was established, and what was not, is in the record at the bottom — read it
before relying on any of this, because a partial rehearsal proves partial
things.

Keep the procedure below for the next one. It is written to be repeated after
any change to the database, the backup configuration, or Railway's own restore
flow.

---

## Before starting

| | |
| --- | --- |
| **Do to production** | Nothing. No restore into it, no variable change, no deploy, no schema edit. |
| **Do instead** | Restore *out of* production's backup, *into* an isolated scratch service. |
| **Time to allow** | An unhurried hour. Do not rehearse while something is broken. |
| **Who** | Yiddi Weller. The rehearsal is partly about learning the console under no pressure. |

The whole point is that production is only ever a **source** here. If a step
ever seems to want production as a target, stop: that is the mistake this
procedure exists to avoid.

---

## Step 1 — Record the starting state

Before touching anything, write down what production currently holds, so the
restored copy can be compared against something rather than merely inspected.

In Railway, open the **production** Postgres service → **Data**, and record:

- the row count of `inquiries`
- the row count of `user` and of `staff_invitations` — once Build 002 is
  promoted, these exist; until then they are zero and that is also a fact worth
  recording
- the `created_at` of the newest row in `inquiries`
- the current time, in UTC

Reading rows is safe. Do not edit anything.

---

## Step 2 — Note the restore point

In the production Postgres service → **Backups** (or **Settings → Backups**,
depending on where Railway currently puts it), find:

- the most recent **weekly** or **monthly** volume backup, with its timestamp
- the **Point-in-Time Recovery** window — the earliest instant PITR can still
  reach

Write both down. The rehearsal should target a moment inside the PITR window,
ideally a few hours old, so that PITR is exercised rather than just a volume
snapshot.

---

## Step 3 — Where the restore lands

**As of the 2026-09-15 rehearsal, Railway does this itself:** starting a
Point-in-Time Recovery from the production service creates a **separate
temporary Postgres service** for the restored copy and leaves production
running. Nothing has to be prepared in advance.

Confirm that is still what the console offers before starting. If a future
version instead offers to restore *over* the source service, stop — that is the
one thing this procedure exists to avoid — and create an isolated environment to
restore into by hand:

1. Railway project → **Environments** → new environment named
   `restore-rehearsal`, holding one Postgres service and nothing else.
2. Confirm the environment selector reads `restore-rehearsal` before every
   further action. This is the step where mistakes happen.

---

## Step 4 — Restore into it

Railway's restore flow was exercised for real on 2026-09-15 and behaved as
described in step 3. Re-check it rather than assuming it has not changed; see
*Railway uncertainty* below for what is still unverified.

The intent, whichever shape the console offers:

- the restored copy lands in a service **of its own**, never over production's
- target the moment chosen in step 2
- production stays online throughout; confirm that as it runs, not afterwards

**Start a timer when the restore begins and stop it when the database accepts a
connection.** The first rehearsal did not, so the platform still has no recovery
time objective. This is the single most valuable thing the next one adds.

---

## Step 5 — Verify the restored database

Connect to the **scratch** service only. Copy its connection string from the
`restore-rehearsal` environment, and check twice that it is not production's.

```bash
# Schema: every table, index and trigger should be present.
psql "$RESTORED_URL" -c '\dt'
psql "$RESTORED_URL" -c '\di'
psql "$RESTORED_URL" -c "select tgname, relname from pg_trigger
  join pg_class on pg_class.oid = tgrelid where not tgisinternal order by relname"

# Migrations: Drizzle's own bookkeeping must match what the repository holds.
psql "$RESTORED_URL" -c 'select * from drizzle.__drizzle_migrations order by created_at'

# Content: compare against what step 1 recorded.
psql "$RESTORED_URL" -c 'select count(*) from inquiries'
psql "$RESTORED_URL" -c 'select max(created_at) from inquiries'
psql "$RESTORED_URL" -c 'select count(*) from "user"'
psql "$RESTORED_URL" -c 'select count(*) from staff_invitations'

# Constraints: the restored copy must still refuse bad data, not merely hold rows.
psql "$RESTORED_URL" -c "insert into inquiries (id, name, email, message, status, dedupe_key)
  values ('00000000-0000-7000-8000-000000000001','x','a@b.com','hi','not-a-status','rehearsal')"
# expected: ERROR — violates check constraint "inquiries_status_check"
```

Then the one check no query can make: **point the application at the restored
database and see it work.** Run it locally, never on a deployed service:

```bash
DATABASE_URL="$RESTORED_URL" npm run db:migrate   # expect: nothing pending
DATABASE_URL="$RESTORED_URL" APP_URL=http://localhost:3000 \
  BETTER_AUTH_SECRET=<a throwaway value> npm run build && npm start
```

Open `/studio`, sign in if Build 002 is promoted by then, and confirm the
inquiries are the ones step 1 recorded. A schema that restores but cannot serve
the application is not a restore.

---

## Step 6 — What counts as a success

All six, or the rehearsal failed and the gap is the finding:

1. A restore completed into an isolated environment, with production untouched.
2. Every table, index, trigger and constraint present.
3. `__drizzle_migrations` matches the repository's `drizzle/` directory.
4. Row counts and the newest `created_at` match step 1, within the difference
   explained by the restore point chosen.
5. A check constraint still rejected bad data.
6. The application booted against the restored database and served real rows.

And one number: **how long step 4 took, wall clock.** That figure is the real
recovery time objective. Nothing else establishes it, and a guess is worse than
no figure at all.

---

## Step 7 — Clean up

1. Delete the Postgres service in `restore-rehearsal`.
2. Delete the `restore-rehearsal` environment.
3. Delete any local `.env` file or shell history entry holding the restored
   connection string. It is a copy of production data and deserves the same
   care as production's own string.
4. Confirm production is untouched: its service, its variables, its latest
   deploy, and its backup schedule all unchanged.

Restored data is production data. Do not leave a copy running because it might
be useful.

---

## Railway uncertainty — verify by hand, do not assume

These are the parts this document cannot settle from the outside, and each one
must be checked in the console during the rehearsal:

- **Where the restore control lives**, and what it is called. Railway has moved
  backups between the service page and its settings tab more than once.
- ~~**Whether a backup can be restored into a different service or
  environment**, or only back into the service it came from.~~ **Answered on
  2026-09-15: Railway restored production into a separate temporary Postgres
  service, leaving production online and untouched.** The `pg_dump` fallback
  this section used to describe is therefore not needed.
- **Whether PITR can target an arbitrary instant** or only the backup
  boundaries, and what the true retention window is.
- **Whether restoring produces a new volume and a new connection string**, and
  whether anything in the environment silently re-points at it.
- **What it costs** to run a second Postgres service for the length of the
  rehearsal.

Write down what the console actually does, in the record below. The next
rehearsal should be a shorter document than this one.

---

## Record

### 2026-09-15 — first rehearsal, successful

| | |
| --- | --- |
| Date | 2026-09-15 |
| Performed by | Yiddi Weller, in the Railway console |
| Method | **Point-in-Time Recovery**, initiated from the live production Postgres service |
| Target | A **separate temporary Postgres service** created by Railway for the restore |
| Production during the rehearsal | **Online and untouched** throughout |
| Result | **Success** |

**What was actually verified**, and nothing beyond it:

- The restore was initiated from the real production Postgres service, not from
  a copy or a dump.
- Railway restored into a separate temporary service rather than over
  production. This settles the open question in *Railway uncertainty* below:
  **a production backup can be restored into a service of its own.**
- The original production database stayed online and unmodified for the whole
  rehearsal.
- The restored service came online successfully.
- Railway connected to the restored database.
- The `inquiries` table was present in the restored copy.
- **Real production inquiry data was present and correct** in it — the point of
  the whole exercise, and the first time production data has been read back out
  of a backup.
- The temporary service **and its volume** were removed afterwards, leaving no
  second copy of production data anywhere.

**What this rehearsal did not establish.** Recorded plainly, because a rehearsal
that is remembered as more thorough than it was is worse than none:

- **No restore duration was measured**, so **there is still no recovery time
  objective.** Nothing in this record should be read as one, and a number must
  not be inferred from it later. Timing the restore is the first thing to add to
  the next rehearsal.
- Schema completeness beyond the presence of `inquiries` — indexes, triggers,
  constraints, and the Build 002 tables once they exist in production — was not
  checked.
- `__drizzle_migrations` was not compared against the repository.
- The application was not booted against the restored database.

Those four are steps 5's checks, and they are what the next rehearsal should
cover now that the mechanism itself is proven. None of them changes what was
established today: **production can be restored, into an isolated service, with
its data intact.**

```
Date                 2026-09-15
Performed by         Yiddi Weller
Restore point        PITR, from the live production service
Restore duration     not measured  ← still no RTO
Method               PITR into a separate temporary Postgres service
Verification         restored service online · connected · inquiries table
                     present · real production inquiry data verified
Result               success
Surprises            none reported
Production touched   no — online and unmodified throughout
Cleanup              temporary service and volume removed
```
