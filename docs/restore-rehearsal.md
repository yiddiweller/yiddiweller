# Restore rehearsal

The procedure for proving that production PostgreSQL can actually be restored.
**It has not been performed.** Nothing in this file may be described as done
until it has been carried out and its evidence recorded at the bottom.

A backup nobody has restored is a hypothesis. This turns it into a fact, and
produces the one number that matters — how long a restore takes — which nothing
else can tell you.

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

## Step 3 — Create the scratch environment

Use a **separate Railway environment**, not a second service inside
`production`, so there is no chance of a restore landing beside the live
database and being mistaken for it.

1. Railway project → **Environments** → new environment named
   `restore-rehearsal`.
2. Confirm the environment selector reads `restore-rehearsal` before every
   further action. This is the step where mistakes happen.
3. That environment gets **no application service**, no domain and no
   variables. It holds one Postgres service and nothing else.

---

## Step 4 — Restore into it

Railway's restore flow is the part of this procedure that is least certain from
documentation alone, and it is deliberately not guessed here. See *Railway
uncertainty* below.

The intent, whichever shape the console offers:

- restore from production's backup **into the `restore-rehearsal` environment's
  Postgres service**, never into production's own service
- target the moment chosen in step 2
- if Railway will only restore a backup into the service it came from, do
  **not** proceed — stop and use the fallback in *Railway uncertainty*

Start a timer when the restore begins. Stop it when the database accepts a
connection. That is the number this rehearsal exists to produce.

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
- **Whether a backup can be restored into a different service or environment**,
  or only back into the service it came from. This decides whether the
  procedure above works at all. If it is restore-in-place only, do **not**
  rehearse against production. The fallback is: take a logical dump of
  production (`pg_dump` over the private connection string, read-only), restore
  that into the scratch service, and rehearse verification against it — noting
  in the record that PITR itself was not exercised, only the dump path.
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

Nothing here yet. This is the shape it should take once performed:

```
Date                 —
Performed by         —
Restore point        —
Restore duration     —   ← the recovery time objective
Method               PITR into a new environment / logical dump fallback
Verification         schema / migrations / row counts / constraint / app boot
Result               —
Surprises            —
Production touched   no
```

Until that table is filled in, the correct statement about production backups
remains: **configured, healthy, and never restored.**
