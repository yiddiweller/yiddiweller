import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { sql } from "drizzle-orm";

import { listAuditEvents, listEntityAudit, type AuditActor } from "../lib/db/audit.ts";
import {
  archiveClient,
  createClient,
  findClient,
  listClients,
  restoreClient,
  similarClients,
  updateClient,
} from "../lib/db/clients.ts";
import {
  archiveContact,
  attachContactToClient,
  clientContactRows,
  createContact,
  detachContactFromClient,
  findContact,
  listContacts,
  similarContacts,
  updateClientContact,
} from "../lib/db/contacts.ts";
import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import { recordInquiry } from "../lib/db/inquiries.ts";
import {
  convertLead,
  countInquiriesAwaitingLead,
  createLead,
  createLeadFromInquiry,
  findLead,
  inquiriesAwaitingLead,
  leadForInquiry,
  leadPipeline,
  leadsNeedingAttention,
  listLeads,
  moveLead,
} from "../lib/db/leads.ts";
import {
  archiveProject,
  countLiveProjects,
  createProject,
  findProject,
  listProjects,
  overdueProjects,
  restoreProject,
  projectContactRows,
  updateProject,
} from "../lib/db/projects.ts";
import { search } from "../lib/db/search.ts";
import {
  clientContacts,
  clients,
  contacts,
  inquiries,
  leads,
  projectContacts,
  projects,
  user,
} from "../lib/db/schema.ts";

/**
 * The business core, at the layer that decides it.
 *
 * These run against a real PostgreSQL, because most of what is being checked
 * here IS PostgreSQL: the unique index that makes one lead per inquiry true no
 * matter who presses first, the version column that makes a lost race a refusal
 * rather than a silent overwrite, the trigger that will not let the audit log
 * be rewritten. A fake database would only prove that the fake agrees with the
 * code that calls it.
 */

const actor: AuditActor = { id: uuidv7(), name: "Test Owner" };

/**
 * Audit is append-only and PostgreSQL refuses UPDATE, DELETE and TRUNCATE on
 * it. Clearing it between tests therefore has to be an explicit, visible act —
 * which is the point: nothing in the application can do this by accident.
 */
async function clearAudit(): Promise<void> {
  await db().execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_truncate`);
  await db().execute(sql`TRUNCATE audit_events`);
  await db().execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_truncate`);
}

async function wipe(): Promise<void> {
  await db().delete(projectContacts);
  await db().delete(clientContacts);
  await db().delete(projects);
  await db().delete(leads);
  await db().delete(contacts);
  await db().delete(clients);
  await db().delete(inquiries);
  await clearAudit();
}

before(async () => {
  await wipe();
  await db().delete(user);
  await db()
    .insert(user)
    .values({ id: actor.id, name: actor.name, email: "owner@example.com", role: "owner" });
});

beforeEach(wipe);

after(async () => {
  await wipe();
  await db().delete(user);
  await closeDb();
});

/* ------------------------------------------------------------------ helpers */

async function aClient(name = "Acme Ltd", domain: string | null = "acme.com"): Promise<string> {
  const outcome = await createClient(actor, {
    accountType: "organization",
    name,
    website: domain ? `https://${domain}` : null,
    domain,
    status: "active",
    notes: "",
  });
  assert.ok(outcome.ok);
  return outcome.value;
}

async function aContact(name = "Dana Rose", email = "dana@acme.com"): Promise<string> {
  const outcome = await createContact(actor, {
    name,
    email,
    emailNormalized: email.toLowerCase(),
    phone: null,
    title: null,
    notes: "",
  });
  assert.ok(outcome.ok);
  return outcome.value;
}

/* ------------------------------------------------------------------ clients */

test("a client starts at version 1 and every save moves it on", async () => {
  const id = await aClient();
  const created = await findClient(id);
  assert.equal(created?.version, 1);

  const saved = await updateClient(
    actor,
    id,
    { accountType: "organization", name: "Acme Limited", website: null, domain: null, status: "active", notes: "" },
    1,
  );
  assert.ok(saved.ok);
  assert.equal((await findClient(id))?.version, 2);
});

test("a save composed against an older version is refused, not applied", async () => {
  const id = await aClient();
  const input = {
    accountType: "organization" as const,
    name: "Second writer",
    website: null,
    domain: null,
    status: "active" as const,
    notes: "",
  };

  assert.ok((await updateClient(actor, id, { ...input, name: "First writer" }, 1)).ok);

  const late = await updateClient(actor, id, input, 1);
  assert.equal(late.ok, false);
  assert.equal(late.ok === false && late.reason, "conflict");
  // The point of the refusal: the first writer's change survived.
  assert.equal((await findClient(id))?.name, "First writer");
});

test("archiving is refused while the client still has live work", async () => {
  const clientId = await aClient();
  const project = await createProject(actor, {
    clientId,
    name: "Website",
    status: "active",
    description: "",
    notes: "",
    ownerId: null,
    startsOn: null,
    targetOn: null,
  });
  assert.ok(project.ok);

  const client = await findClient(clientId);
  const blocked = await archiveClient(actor, clientId, client!.version);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.reason, "blocked");
  assert.match(blocked.ok === false ? blocked.message : "", /Website/);

  // Finish the work, and the same request is allowed.
  const before = await findProject(project.value);
  assert.ok(
    (await updateProject(
      actor,
      project.value,
      { name: "Website", status: "completed", description: "", notes: "", ownerId: null, startsOn: null, targetOn: null },
      before!.version,
    )).ok,
  );

  const now = await findClient(clientId);
  assert.ok((await archiveClient(actor, clientId, now!.version)).ok);
  assert.ok((await findClient(clientId))?.archivedAt instanceof Date);
});

test("archived clients leave the default list and come back on restore", async () => {
  const id = await aClient();
  const before = await findClient(id);
  assert.ok((await archiveClient(actor, id, before!.version)).ok);

  assert.equal((await listClients()).total, 0);
  assert.equal((await listClients({ archived: "archived" })).total, 1);

  const archived = await findClient(id);
  assert.ok((await restoreClient(actor, id, archived!.version)).ok);
  assert.equal((await listClients()).total, 1);
});

test("the client list carries its primary contact and live project count", async () => {
  const clientId = await aClient();
  const contactId = await aContact();
  assert.ok(
    (await attachContactToClient(actor, { clientId, contactId, role: "Owner", isPrimary: true })).ok,
  );
  assert.ok(
    (await createProject(actor, {
      clientId,
      name: "Website",
      status: "active",
      description: "",
      notes: "",
      ownerId: null,
      startsOn: null,
      targetOn: null,
    })).ok,
  );

  const { rows } = await listClients();
  assert.equal(rows[0]?.primaryContactName, "Dana Rose");
  assert.equal(rows[0]?.liveProjects, 1);
});

test("similar clients are a warning, and the second one is still allowed", async () => {
  await aClient("Acme Ltd", "acme.com");
  const similar = await similarClients({ name: "acme ltd", domain: null });
  assert.equal(similar.length, 1);
  await aClient("Acme Ltd", "acme.com");
  assert.equal((await listClients()).total, 2);
});

/* ----------------------------------------------------------------- contacts */

test("a person can be related to several clients without being duplicated", async () => {
  const contactId = await aContact();
  const one = await aClient("Acme Ltd", "acme.com");
  const two = await aClient("Beta Co", "beta.co");

  assert.ok((await attachContactToClient(actor, { clientId: one, contactId, role: null, isPrimary: true })).ok);
  assert.ok((await attachContactToClient(actor, { clientId: two, contactId, role: null, isPrimary: true })).ok);

  assert.equal((await listContacts()).total, 1);
  assert.equal((await listContacts({ clientId: one })).total, 1);
  assert.equal((await clientContactRows(one)).length, 1);
});

test("attaching the same person to the same client twice is already done, not an error", async () => {
  const clientId = await aClient();
  const contactId = await aContact();
  assert.ok((await attachContactToClient(actor, { clientId, contactId, role: null, isPrimary: false })).ok);

  const again = await attachContactToClient(actor, { clientId, contactId, role: null, isPrimary: false });
  assert.equal(again.ok, false);
  assert.equal(again.ok === false && again.reason, "already_done");
  assert.equal((await clientContactRows(clientId)).length, 1);
});

test("naming a new primary contact stands the previous one down", async () => {
  const clientId = await aClient();
  const first = await aContact("Dana Rose", "dana@acme.com");
  const second = await aContact("Sam Fox", "sam@acme.com");

  assert.ok((await attachContactToClient(actor, { clientId, contactId: first, role: null, isPrimary: true })).ok);
  assert.ok((await attachContactToClient(actor, { clientId, contactId: second, role: null, isPrimary: true })).ok);

  const rows = await clientContactRows(clientId);
  assert.deepEqual(
    rows.map((row) => [row.contactName, row.isPrimary]).sort(),
    [["Dana Rose", false], ["Sam Fox", true]].sort(),
  );
});

test("a contact who is somebody's named primary cannot be archived away", async () => {
  const clientId = await aClient();
  const contactId = await aContact();
  const [link] = [
    await attachContactToClient(actor, { clientId, contactId, role: null, isPrimary: true }),
  ];
  assert.ok(link.ok);

  const contact = await findContact(contactId);
  const blocked = await archiveContact(actor, contactId, contact!.version);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.reason, "blocked");

  // Standing them down is enough — they do not have to be detached.
  const rows = await clientContactRows(clientId);
  assert.ok(
    (await updateClientContact(actor, rows[0]!.id, { role: null, isPrimary: false }, rows[0]!.version)).ok,
  );
  assert.ok((await archiveContact(actor, contactId, contact!.version)).ok);
});

test("detaching removes the relationship and keeps both records", async () => {
  const clientId = await aClient();
  const contactId = await aContact();
  const link = await attachContactToClient(actor, { clientId, contactId, role: null, isPrimary: false });
  assert.ok(link.ok);

  assert.ok((await detachContactFromClient(actor, link.value)).ok);
  assert.equal((await clientContactRows(clientId)).length, 0);
  assert.ok(await findContact(contactId));
  assert.ok(await findClient(clientId));
});

test("a shared address is not a duplicate, only a warning", async () => {
  await aContact("Dana Rose", "office@acme.com");
  const second = await aContact("Sam Fox", "office@acme.com");
  const similar = await similarContacts({ name: "Sam Fox", emailNormalized: "office@acme.com" }, second);
  assert.equal(similar.length, 1);
  assert.equal(similar[0]?.name, "Dana Rose");
});

/* ------------------------------------------------------------ inquiry → lead */

async function anInquiry(email = "dana@acme.com"): Promise<string> {
  const recorded = await recordInquiry({
    name: "Dana Rose",
    email,
    message: "We would like a new website, please.",
  });
  return recorded.id;
}

test("an inquiry becomes exactly one lead, however many times it is asked", async () => {
  const inquiryId = await anInquiry();

  const first = await createLeadFromInquiry(actor, inquiryId);
  assert.ok(first.ok);
  assert.equal(first.value.created, true);

  const second = await createLeadFromInquiry(actor, inquiryId);
  assert.ok(second.ok);
  assert.equal(second.value.created, false);
  assert.equal(second.value.leadId, first.value.leadId);

  assert.equal((await listLeads()).total, 1);
});

test("two people pressing at the same moment still produce one lead", async () => {
  const inquiryId = await anInquiry();

  const [a, b] = await Promise.all([
    createLeadFromInquiry(actor, inquiryId),
    createLeadFromInquiry(actor, inquiryId),
  ]);

  assert.ok(a.ok);
  assert.ok(b.ok);
  assert.equal(a.value.leadId, b.value.leadId);
  assert.equal((await listLeads()).total, 1);

  // And one person, not two: the losing transaction may have created a contact
  // before the lead index turned it away, so this is worth asserting rather
  // than assuming.
  assert.equal((await listContacts()).total, 1);
});

test("the inquiry is left exactly as it was, and the lead points back at it", async () => {
  const inquiryId = await anInquiry();
  const before = await db().select().from(inquiries).where(sql`id = ${inquiryId}`);

  const created = await createLeadFromInquiry(actor, inquiryId);
  assert.ok(created.ok);

  const after = await db().select().from(inquiries).where(sql`id = ${inquiryId}`);
  assert.deepEqual(after, before);

  const lead = await findLead(created.value.leadId);
  assert.equal(lead?.inquiryId, inquiryId);
  assert.equal(lead?.source, "inquiry");
  // The message stays where it was written. The lead is our reading of it.
  assert.equal(lead?.summary, "");
  assert.equal((await leadForInquiry(inquiryId))?.id, created.value.leadId);
});

test("the person who wrote in is reused rather than copied", async () => {
  const known = await aContact("Dana Rose", "dana@acme.com");
  const created = await createLeadFromInquiry(actor, await anInquiry("Dana@Acme.com"));
  assert.ok(created.ok);

  assert.equal((await listContacts()).total, 1);
  assert.equal((await findLead(created.value.leadId))?.contactId, known);
});

/* ----------------------------------------------------------------- pipeline */

test("a lead moves through the stages, and won is not one of the moves", async () => {
  const created = await createLead(actor, {
    title: "Acme website",
    source: "referral",
    contactId: null,
    clientId: null,
    prospectName: "Acme Ltd",
    summary: "",
    nextStep: "",
    followUpAt: null,
    ownerId: null,
  });
  assert.ok(created.ok);
  const id = created.value;

  const lead = await findLead(id);
  assert.ok((await moveLead(actor, id, "discovery", lead!.version)).ok);

  const won = await moveLead(actor, id, "won", (await findLead(id))!.version);
  assert.equal(won.ok, false);
  assert.equal(won.ok === false && won.reason, "blocked");

  const lost = await moveLead(actor, id, "lost", (await findLead(id))!.version, "Chose somebody else");
  assert.ok(lost.ok);
  const after = await findLead(id);
  assert.equal(after?.stage, "lost");
  assert.ok(after?.lostAt instanceof Date);

  // Reopening clears the outcome rather than leaving a stale reason behind.
  assert.ok((await moveLead(actor, id, "discovery", after!.version)).ok);
  assert.equal((await findLead(id))?.lostReason, null);
});

test("the pipeline returns every open stage, including the empty ones", async () => {
  const board = await leadPipeline(["new", "discovery", "proposal"]);
  assert.deepEqual(Object.keys(board).sort(), ["discovery", "new", "proposal"]);
  assert.deepEqual(board.new, []);
});

/* ----------------------------------------------------------- lead → project */

async function aLeadReadyToConvert(): Promise<string> {
  const created = await createLeadFromInquiry(actor, await anInquiry());
  assert.ok(created.ok);
  return created.value.leadId;
}

const CONVERSION = {
  clientId: null,
  newClientName: "Acme Ltd",
  newClientAccountType: "organization" as const,
  withProject: true,
  projectName: "Acme website",
  projectStatus: "planned" as const,
  projectDescription: "",
  startsOn: null,
  targetOn: null,
  ownerId: null,
};

test("converting produces the client, the project and the relationships together", async () => {
  const leadId = await aLeadReadyToConvert();
  const lead = await findLead(leadId);

  const converted = await convertLead(actor, leadId, lead!.version, CONVERSION);
  assert.ok(converted.ok);

  assert.ok(converted.value.projectId);
  const project = await findProject(converted.value.projectId);
  assert.equal(project?.clientName, "Acme Ltd");
  assert.equal(project?.leadId, leadId);

  const after = await findLead(leadId);
  assert.equal(after?.stage, "won");
  assert.equal(after?.projectId, converted.value.projectId);
  assert.equal(after?.clientId, converted.value.clientId);
  assert.ok(after?.convertedAt instanceof Date);

  // The person who has been the whole conversation comes with it.
  assert.equal((await clientContactRows(converted.value.clientId))[0]?.isPrimary, true);
  assert.equal((await projectContactRows(converted.value.projectId!))[0]?.contactName, "Dana Rose");
});

test("converting twice is refused, and the second attempt writes nothing", async () => {
  const leadId = await aLeadReadyToConvert();
  const first = await convertLead(actor, leadId, (await findLead(leadId))!.version, CONVERSION);
  assert.ok(first.ok);

  const again = await convertLead(actor, leadId, (await findLead(leadId))!.version, CONVERSION);
  assert.equal(again.ok, false);
  assert.equal(again.ok === false && again.reason, "already_done");

  assert.equal((await listClients()).total, 1);
  assert.equal((await listProjects()).total, 1);
});

test("a conversion that loses the race leaves nothing behind", async () => {
  const leadId = await aLeadReadyToConvert();
  const stale = (await findLead(leadId))!.version;

  // Somebody edits the lead first, so the version the form carried is old.
  assert.ok((await moveLead(actor, leadId, "proposal", stale)).ok);

  const lost = await convertLead(actor, leadId, stale, CONVERSION);
  assert.equal(lost.ok, false);
  assert.equal(lost.ok === false && lost.reason, "conflict");

  // No half-made client, and no orphaned project.
  assert.equal((await listClients()).total, 0);
  assert.equal((await listProjects()).total, 0);
  assert.equal((await findLead(leadId))?.stage, "proposal");
});

test("converting onto an existing client adds work rather than a second client", async () => {
  const clientId = await aClient();
  const leadId = await aLeadReadyToConvert();

  const converted = await convertLead(actor, leadId, (await findLead(leadId))!.version, {
    ...CONVERSION,
    clientId,
  });
  assert.ok(converted.ok);
  assert.equal(converted.value.clientId, clientId);
  assert.equal((await listClients()).total, 1);
});

test("a lead can be won before there is any work to point at", async () => {
  const leadId = await aLeadReadyToConvert();

  const converted = await convertLead(actor, leadId, (await findLead(leadId))!.version, {
    ...CONVERSION,
    withProject: false,
  });
  assert.ok(converted.ok);
  assert.equal(converted.value.projectId, null);

  const lead = await findLead(leadId);
  assert.equal(lead?.stage, "won");
  assert.ok(lead?.convertedAt instanceof Date);
  assert.equal(lead?.projectId, null);

  // A client, and the person on it, still came across.
  assert.equal((await listClients()).total, 1);
  assert.equal((await listProjects()).total, 0);
  assert.equal((await clientContactRows(converted.value.clientId))[0]?.contactName, "Dana Rose");

  // And it is still converted, so it cannot happen twice.
  const again = await convertLead(actor, leadId, (await findLead(leadId))!.version, CONVERSION);
  assert.equal(again.ok, false);
  assert.equal(again.ok === false && again.reason, "already_done");
});

test("a project cannot be archived while it is still live", async () => {
  const clientId = await aClient();
  const created = await createProject(actor, {
    clientId,
    name: "Website",
    status: "active",
    description: "",
    notes: "",
    ownerId: null,
    startsOn: null,
    targetOn: null,
  });
  assert.ok(created.ok);

  const project = await findProject(created.value);
  const blocked = await archiveProject(actor, created.value, project!.version);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.reason, "blocked");
});

/* ---------------------------------------------------------------- attention */

test("what needs attention is a condition on a row, never a flag", async () => {
  const inquiryId = await anInquiry();

  // An inquiry nobody has decided about yet.
  assert.equal(await countInquiriesAwaitingLead(), 1);
  assert.deepEqual((await inquiriesAwaitingLead()).map((row) => row.id), [inquiryId]);

  // Making the lead answers the question, so it stops asking.
  const created = await createLeadFromInquiry(actor, inquiryId);
  assert.ok(created.ok);
  assert.equal(await countInquiriesAwaitingLead(), 0);
  assert.deepEqual(await inquiriesAwaitingLead(), []);
});

test("a follow-up is due only once its time has passed", async () => {
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60 * 60_000);

  const lead = await createLead(actor, {
    title: "Overdue call",
    source: "manual",
    contactId: null,
    clientId: null,
    prospectName: null,
    summary: "",
    nextStep: "Ring them",
    followUpAt: past,
    ownerId: null,
  });
  assert.ok(lead.ok);

  assert.ok(
    (await createLead(actor, {
      title: "Later call",
      source: "manual",
      contactId: null,
      clientId: null,
      prospectName: null,
      summary: "",
      nextStep: "",
      followUpAt: future,
      ownerId: null,
    })).ok,
  );

  const due = await leadsNeedingAttention(new Date());
  assert.deepEqual(due.map((row) => row.title), ["Overdue call"]);

  // Closing it takes it off the list without anybody editing the date.
  assert.ok((await moveLead(actor, lead.value, "lost", (await findLead(lead.value))!.version)).ok);
  assert.deepEqual(await leadsNeedingAttention(new Date()), []);
});

test("live work past its target is overdue, and finished work is not", async () => {
  const clientId = await aClient();
  const make = async (name: string, status: "active" | "completed", targetOn: string) => {
    const created = await createProject(actor, {
      clientId,
      name,
      status,
      description: "",
      notes: "",
      ownerId: null,
      startsOn: null,
      targetOn,
    });
    assert.ok(created.ok);
  };

  await make("Late website", "active", "2020-01-01");
  await make("Finished on time", "completed", "2020-01-01");
  await make("Due next year", "active", "2999-01-01");

  const overdue = await overdueProjects("2026-09-15");
  assert.deepEqual(overdue.map((row) => row.name), ["Late website"]);
  assert.equal(await countLiveProjects(), 2);
});

test("a project is not restored back under an archived client", async () => {
  const clientId = await aClient();
  const created = await createProject(actor, {
    clientId,
    name: "Old website",
    status: "completed",
    description: "",
    notes: "",
    ownerId: null,
    startsOn: null,
    targetOn: null,
  });
  assert.ok(created.ok);

  assert.ok((await archiveProject(actor, created.value, (await findProject(created.value))!.version)).ok);
  assert.ok((await archiveClient(actor, clientId, (await findClient(clientId))!.version)).ok);

  const blocked = await restoreProject(actor, created.value, (await findProject(created.value))!.version);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.reason, "blocked");

  // Restoring the client first is all it takes.
  assert.ok((await restoreClient(actor, clientId, (await findClient(clientId))!.version)).ok);
  assert.ok((await restoreProject(actor, created.value, (await findProject(created.value))!.version)).ok);
});

/* ------------------------------------------------------------------- search */

test("search finds each kind of record and nothing archived", async () => {
  const clientId = await aClient("Northwind Trading", "northwind.test");
  await aContact("Nora Wind", "nora@northwind.test");
  assert.ok(
    (await createProject(actor, {
      clientId,
      name: "Northwind rebrand",
      status: "planned",
      description: "",
      notes: "",
      ownerId: null,
      startsOn: null,
      targetOn: null,
    })).ok,
  );
  assert.ok(
    (await createLead(actor, {
      title: "Northwind retainer",
      source: "referral",
      contactId: null,
      clientId: null,
      prospectName: null,
      summary: "",
      nextStep: "",
      followUpAt: null,
      ownerId: null,
    })).ok,
  );

  const hits = await search("north");
  assert.deepEqual(
    [...new Set(hits.map((hit) => hit.kind))].sort(),
    ["client", "contact", "lead", "project"],
  );
  assert.ok(hits.every((hit) => hit.href.startsWith("/studio/")));

  // One character is not a search, it is every record you have.
  assert.deepEqual(await search("n"), []);
});

test("search treats a wildcard as the character somebody typed", async () => {
  await aClient("Acme Ltd", "acme.com");
  assert.deepEqual(await search("%%"), []);
});

/* -------------------------------------------------------------------- audit */

test("every change writes one event, and the event names fields but not values", async () => {
  const id = await aClient();
  await updateClient(
    actor,
    id,
    {
      accountType: "organization",
      name: "Acme Ltd",
      website: null,
      domain: null,
      status: "active",
      notes: "Something private a client told us.",
    },
    1,
  );

  const history = await listEntityAudit("client", id);
  assert.deepEqual(history.map((event) => event.action), ["client.updated", "client.created"]);
  assert.equal(history[0]?.actorName, "Test Owner");
  assert.deepEqual(history[0]?.metadata.fields, ["website", "domain", "notes"]);

  const serialized = JSON.stringify(history);
  assert.ok(!serialized.includes("Something private"));
});

/** Drizzle wraps driver errors, so what PostgreSQL said lives down the chain. */
function causeChain(error: unknown): string {
  const seen: string[] = [];
  let current: unknown = error;
  for (let i = 0; current instanceof Error && i < 5; i++) {
    seen.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return seen.join(" | ");
}

async function refusedByPostgres(statement: ReturnType<typeof sql>): Promise<string> {
  try {
    await db().execute(statement);
  } catch (error) {
    return causeChain(error);
  }
  throw new Error("the statement was allowed");
}

test("the audit log refuses to be rewritten", async () => {
  await aClient();
  const { rows } = await listAuditEvents();
  assert.equal(rows.length, 1);

  assert.match(
    await refusedByPostgres(sql`UPDATE audit_events SET action = 'client.tampered'`),
    /append-only: UPDATE/,
  );
  assert.match(await refusedByPostgres(sql`DELETE FROM audit_events`), /append-only: DELETE/);
  assert.match(await refusedByPostgres(sql`TRUNCATE audit_events`), /append-only: TRUNCATE/);

  assert.equal((await listAuditEvents()).rows[0]?.action, "client.created");
});

test("a refused change leaves no audit event behind", async () => {
  const id = await aClient();
  await clearAudit();

  const late = await updateClient(
    actor,
    id,
    { accountType: "organization", name: "Nope", website: null, domain: null, status: "active", notes: "" },
    99,
  );
  assert.equal(late.ok, false);
  assert.equal((await listAuditEvents()).total, 0);
});

test("a conversion writes its events only when the conversion happens", async () => {
  const leadId = await aLeadReadyToConvert();
  const stale = (await findLead(leadId))!.version;
  assert.ok((await moveLead(actor, leadId, "proposal", stale)).ok);
  await clearAudit();

  const lost = await convertLead(actor, leadId, stale, CONVERSION);
  assert.equal(lost.ok, false);
  assert.equal((await listAuditEvents()).total, 0);

  const won = await convertLead(actor, leadId, (await findLead(leadId))!.version, CONVERSION);
  assert.ok(won.ok);
  const actions = (await listAuditEvents()).rows.map((event) => event.action).sort();
  assert.deepEqual(actions, [
    "client.created",
    "client_contact.attached",
    "lead.converted",
    "project.created",
    "project_contact.attached",
  ]);
});
