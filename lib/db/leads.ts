import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { record, type AuditActor, changedFields } from "./audit.ts";
import { insertClient } from "./clients.ts";
import { insertContact } from "./contacts.ts";
import { db, type Tx } from "./index.ts";
import { uuidv7 } from "./id.ts";
import { CONFLICT_MESSAGE, ok, refuse, expectUnchanged, type Outcome, type Refusal } from "./outcome.ts";
import { insertProject } from "./projects.ts";
import {
  clientContacts,
  clients,
  contacts,
  inquiries,
  LEAD_CLOSED_STAGES,
  leads,
  projectContacts,
  user,
  type ClientAccountType,
  type LeadSource,
  type LeadStage,
  type ProjectStatus,
} from "./schema.ts";

/**
 * Leads: an opportunity, which is not yet work and may never become any. A lead
 * is the only record in the business core that can exist before we know who the
 * client is — that is the whole point of it — so `clientId` is optional and
 * `prospectName` carries the name of a company that is not one yet. The model
 * is in docs/business-core.md.
 *
 * Two flows here are the ones worth being careful about, and both are one
 * transaction with the database deciding rather than a read the caller passed:
 *
 *   inquiry → lead   at most one lead per inquiry, enforced by a unique index
 *   lead → project   converts once, and produces the client, the project and
 *                    the relationships together or not at all
 */

export type Lead = {
  id: string;
  title: string;
  stage: LeadStage;
  source: LeadSource;
  inquiryId: string | null;
  contactId: string | null;
  clientId: string | null;
  prospectName: string | null;
  summary: string;
  nextStep: string;
  followUpAt: Date | null;
  ownerId: string | null;
  lostReason: string | null;
  wonAt: Date | null;
  lostAt: Date | null;
  projectId: string | null;
  convertedAt: Date | null;
  version: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LeadRow = Lead & {
  contactName: string | null;
  clientName: string | null;
  ownerName: string | null;
};

export type LeadInput = {
  title: string;
  source: LeadSource;
  contactId: string | null;
  clientId: string | null;
  prospectName: string | null;
  summary: string;
  nextStep: string;
  followUpAt: Date | null;
  ownerId: string | null;
};

export type LeadFilter = {
  query?: string;
  stage?: LeadStage | null;
  source?: LeadSource | null;
  ownerId?: string | null;
  clientId?: string | null;
  contactId?: string | null;
  open?: boolean;
  archived?: "active" | "archived";
  page?: number;
  pageSize?: number;
};

const columns = {
  id: leads.id,
  title: leads.title,
  stage: leads.stage,
  source: leads.source,
  inquiryId: leads.inquiryId,
  contactId: leads.contactId,
  clientId: leads.clientId,
  prospectName: leads.prospectName,
  summary: leads.summary,
  nextStep: leads.nextStep,
  followUpAt: leads.followUpAt,
  ownerId: leads.ownerId,
  lostReason: leads.lostReason,
  wonAt: leads.wonAt,
  lostAt: leads.lostAt,
  projectId: leads.projectId,
  convertedAt: leads.convertedAt,
  version: leads.version,
  archivedAt: leads.archivedAt,
  createdAt: leads.createdAt,
  updatedAt: leads.updatedAt,
};

const joined = {
  ...columns,
  contactName: contacts.name,
  clientName: clients.name,
  ownerName: user.name,
};

function withNames() {
  return db()
    .select(joined)
    .from(leads)
    .leftJoin(contacts, eq(contacts.id, leads.contactId))
    .leftJoin(clients, eq(clients.id, leads.clientId))
    .leftJoin(user, eq(user.id, leads.ownerId));
}

function filterClause(filter: LeadFilter): SQL | undefined {
  const where: SQL[] = [];

  where.push(filter.archived === "archived" ? isNotNull(leads.archivedAt) : isNull(leads.archivedAt));
  if (filter.stage) where.push(eq(leads.stage, filter.stage));
  if (filter.source) where.push(eq(leads.source, filter.source));
  if (filter.ownerId) where.push(eq(leads.ownerId, filter.ownerId));
  if (filter.clientId) where.push(eq(leads.clientId, filter.clientId));
  if (filter.contactId) where.push(eq(leads.contactId, filter.contactId));
  // "Open" is everything still being worked: not won, not lost.
  if (filter.open) where.push(sql`${leads.stage} NOT IN ('won', 'lost')`);
  if (filter.query) {
    const like = `%${filter.query}%`;
    where.push(or(ilike(leads.title, like), ilike(leads.prospectName, like)) as SQL);
  }

  return where.length > 0 ? and(...where) : undefined;
}

export async function listLeads(
  filter: LeadFilter = {},
): Promise<{ rows: LeadRow[]; total: number }> {
  const pageSize = filter.pageSize ?? 25;
  const page = filter.page ?? 1;
  const clause = filterClause(filter);

  const [rows, [total]] = await Promise.all([
    withNames()
      .where(clause)
      .orderBy(desc(leads.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db().select({ n: count() }).from(leads).where(clause),
  ]);

  return { rows: rows as LeadRow[], total: total?.n ?? 0 };
}

/**
 * The pipeline, as one query rather than one per column. The board shows the
 * open stages; won and lost are outcomes and belong in the list, where they can
 * be filtered for rather than sitting permanently on screen.
 */
export async function leadPipeline(
  stages: readonly LeadStage[],
  perStage = 50,
): Promise<Record<string, LeadRow[]>> {
  const rows = (await withNames()
    .where(and(isNull(leads.archivedAt), inArray(leads.stage, [...stages])))
    .orderBy(asc(leads.followUpAt), desc(leads.updatedAt))
    .limit(perStage * stages.length)) as LeadRow[];

  const byStage: Record<string, LeadRow[]> = {};
  for (const stage of stages) byStage[stage] = [];
  for (const row of rows) byStage[row.stage]?.push(row);
  return byStage;
}

export async function findLead(id: string): Promise<LeadRow | null> {
  const [row] = await withNames().where(eq(leads.id, id)).limit(1);
  return (row as LeadRow | undefined) ?? null;
}

/** How many leads are waiting on somebody, for Home. */
export async function leadsNeedingAttention(now: Date, limit = 5): Promise<LeadRow[]> {
  return (await withNames()
    .where(
      and(
        isNull(leads.archivedAt),
        sql`${leads.stage} NOT IN ('won', 'lost')`,
        isNotNull(leads.followUpAt),
        lte(leads.followUpAt, now),
      ),
    )
    .orderBy(asc(leads.followUpAt))
    .limit(limit)) as LeadRow[];
}

export async function createLead(actor: AuditActor, input: LeadInput): Promise<Outcome<string>> {
  const id = uuidv7();

  await db().transaction(async (tx) => {
    await tx.insert(leads).values({ ...input, id, createdBy: actor.id, updatedBy: actor.id });
    await record(tx, actor, {
      action: "lead.created",
      entityType: "lead",
      entityId: id,
      entityLabel: input.title,
      metadata: { source: input.source },
    });
  });

  return ok(id);
}

/**
 * The editable detail of a lead. Stage is not here: moving through the pipeline
 * has consequences — a date, a reason, eventually a project — and burying it in
 * a general save would make those consequences depend on which form somebody
 * happened to use. `moveLead` owns it.
 */
export async function updateLead(
  actor: AuditActor,
  id: string,
  input: LeadInput,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const before = await findLead(id);
  if (!before) return refuse("not_found", "That lead no longer exists.");

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(leads)
      .set({ ...input, updatedBy: actor.id })
      .where(and(eq(leads.id, id), eq(leads.version, expectedVersion)))
      .returning({ id: leads.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await record(tx, actor, {
      action: "lead.updated",
      entityType: "lead",
      entityId: id,
      entityLabel: input.title,
      // The names of what changed, never the values. See docs/audit.md.
      metadata: { fields: changedFields(before as unknown as Record<string, unknown>, input) },
    });

    return ok(undefined);
  });
}

/**
 * Moves a lead through the pipeline.
 *
 * Won is reached by converting, not by choosing it: a lead marked won with no
 * project behind it is a claim the rest of the system cannot see. `convertLead`
 * is what sets it.
 */
export async function moveLead(
  actor: AuditActor,
  id: string,
  stage: LeadStage,
  expectedVersion: number,
  lostReason: string | null = null,
): Promise<Outcome<void>> {
  const lead = await findLead(id);
  if (!lead) return refuse("not_found", "That lead no longer exists.");
  if (lead.stage === stage) return ok(undefined);

  if (stage === "won") {
    return refuse("blocked", "A lead is won by converting it into a project, not by moving it.");
  }
  if (lead.convertedAt) {
    return refuse("blocked", "This lead has already become a project, so its stage is settled.");
  }

  const now = new Date();
  const closing = (LEAD_CLOSED_STAGES as readonly string[]).includes(stage);

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(leads)
      .set({
        stage,
        lostAt: stage === "lost" ? now : null,
        lostReason: stage === "lost" ? lostReason : null,
        updatedBy: actor.id,
      })
      .where(and(eq(leads.id, id), eq(leads.version, expectedVersion)))
      .returning({ id: leads.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await record(tx, actor, {
      action: "lead.moved",
      entityType: "lead",
      entityId: id,
      entityLabel: lead.title,
      // The stage names are vocabulary, not somebody's words. The reason is
      // free text, so only whether one was given is recorded. See docs/audit.md.
      metadata: { from: lead.stage, to: stage, reason_given: closing && Boolean(lostReason) },
    });

    return ok(undefined);
  });
}

export async function archiveLead(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const lead = await findLead(id);
  if (!lead) return refuse("not_found", "That lead no longer exists.");
  if (lead.archivedAt) return ok(undefined);

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(leads)
      .set({ archivedAt: new Date(), updatedBy: actor.id })
      .where(and(eq(leads.id, id), eq(leads.version, expectedVersion)))
      .returning({ id: leads.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await record(tx, actor, {
      action: "lead.archived",
      entityType: "lead",
      entityId: id,
      entityLabel: lead.title,
    });
    return ok(undefined);
  });
}

export async function restoreLead(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const lead = await findLead(id);
  if (!lead) return refuse("not_found", "That lead no longer exists.");
  if (!lead.archivedAt) return ok(undefined);

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(leads)
      .set({ archivedAt: null, updatedBy: actor.id })
      .where(and(eq(leads.id, id), eq(leads.version, expectedVersion)))
      .returning({ id: leads.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await record(tx, actor, {
      action: "lead.restored",
      entityType: "lead",
      entityId: id,
      entityLabel: lead.title,
    });
    return ok(undefined);
  });
}

/* ------------------------------------------------------------ inquiry → lead */

export type LeadFromInquiry = {
  leadId: string;
  /** False when a lead for this inquiry already existed. */
  created: boolean;
};

/**
 * Turns an inquiry into a lead, once.
 *
 * The inquiry is left exactly as it is: it is the record of what somebody
 * actually sent, and a lead is our interpretation of it. Nothing is copied
 * across except the person, because the lead links back and the message stays
 * where it was written.
 *
 * Two people pressing the button at the same moment produce one lead, because
 * `leads_one_per_inquiry_idx` decides rather than a read that both of them
 * passed. The loser is told what already exists and sent to it.
 */
export async function createLeadFromInquiry(
  actor: AuditActor,
  inquiryId: string,
): Promise<Outcome<LeadFromInquiry>> {
  const [inquiry] = await db()
    .select({
      id: inquiries.id,
      name: inquiries.name,
      email: inquiries.email,
    })
    .from(inquiries)
    .where(eq(inquiries.id, inquiryId))
    .limit(1);

  if (!inquiry) return refuse("not_found", "That inquiry no longer exists.");

  const emailNormalized = inquiry.email.trim().toLowerCase();

  return db().transaction(async (tx) => {
    // Reuse the person if we already know them, rather than creating a second
    // copy of somebody every time they write in.
    const [existingContact] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.emailNormalized, emailNormalized), isNull(contacts.archivedAt)))
      .orderBy(asc(contacts.createdAt))
      .limit(1);

    let contactId = existingContact?.id ?? null;
    if (!contactId) {
      contactId = uuidv7();
      await insertContact(tx, actor, contactId, {
        name: inquiry.name,
        email: inquiry.email,
        emailNormalized,
        phone: null,
        title: null,
        notes: "",
      });
    }

    const leadId = uuidv7();
    const inserted = await tx
      .insert(leads)
      .values({
        id: leadId,
        title: `Inquiry from ${inquiry.name}`.slice(0, 160),
        source: "inquiry",
        inquiryId: inquiry.id,
        contactId,
        ownerId: actor.id,
        createdBy: actor.id,
        updatedBy: actor.id,
      })
      // The index is partial, so Postgres needs its predicate here too before
      // it will accept this as the conflict target.
      .onConflictDoNothing({ target: leads.inquiryId, where: isNotNull(leads.inquiryId) })
      .returning({ id: leads.id });

    if (inserted.length === 0) {
      const [existing] = await tx
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.inquiryId, inquiry.id))
        .limit(1);

      // Nothing this transaction did is worth keeping if the lead already
      // existed, but the contact may have been created for it — and a person we
      // now know about is not a mistake, so it stays.
      return ok({ leadId: existing!.id, created: false });
    }

    await record(tx, actor, {
      action: "lead.created_from_inquiry",
      entityType: "lead",
      entityId: leadId,
      entityLabel: `Inquiry from ${inquiry.name}`,
      // The inquiry's id, never a word of its message. See docs/audit.md.
      metadata: { inquiry_id: inquiry.id, contact_id: contactId },
    });

    return ok({ leadId, created: true });
  });
}

/* ----------------------------------------------------------- lead → project */

export type ConvertLeadInput = {
  /** An existing client, when one was chosen. Null means create one. */
  clientId: string | null;
  newClientName: string;
  newClientAccountType: ClientAccountType;
  /**
   * Whether the work is being set up now. A lead can be won before there is a
   * project to point at — an agreement reached, the shape of the work still
   * being settled — and forcing a placeholder project to record that would put
   * a lie in the projects list. See docs/business-core.md.
   */
  withProject: boolean;
  projectName: string;
  projectStatus: ProjectStatus;
  projectDescription: string;
  startsOn: string | null;
  targetOn: string | null;
  ownerId: string | null;
};

export type Converted = { projectId: string | null; clientId: string };

/**
 * Carries a refusal out of a transaction. Throwing is what rolls the
 * transaction back, so a conversion that cannot finish leaves nothing behind —
 * no half-made client, no project pointing at a lead that never moved.
 */
class Rolled extends Error {
  // Written out rather than as parameter properties: the test runner strips
  // types rather than compiling them, and that shorthand is not strippable.
  reason: Refusal;
  detail: string;

  constructor(reason: Refusal, detail: string) {
    super(detail);
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Converts a lead into work: a client if there is not one yet, a project, the
 * relationships that make both readable, and the lead marked won and pointed at
 * what it produced. All of it, or none of it.
 *
 * Converting twice is not possible: the claim on the lead requires `project_id`
 * to still be null, so the second attempt matches no row and everything it had
 * already inserted is rolled back.
 */
export async function convertLead(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
  input: ConvertLeadInput,
): Promise<Outcome<Converted>> {
  const lead = await findLead(id);
  if (!lead) return refuse("not_found", "That lead no longer exists.");
  if (lead.archivedAt) return refuse("blocked", "Restore this lead before converting it.");
  if (lead.convertedAt) return refuse("already_done", "This lead has already been converted.");

  const now = new Date();

  try {
    return await db().transaction(async (tx) => {
      const clientId = await resolveClient(tx, actor, lead, input);
      let projectId: string | null = null;

      if (input.withProject) {
        projectId = uuidv7();
        await insertProject(tx, actor, projectId, {
          clientId,
          leadId: lead.id,
          name: input.projectName,
          status: input.projectStatus,
          description: input.projectDescription,
          notes: "",
          ownerId: input.ownerId ?? lead.ownerId,
          startsOn: input.startsOn,
          targetOn: input.targetOn,
        });
      }

      if (lead.contactId) await carryContactAcross(tx, actor, lead.contactId, clientId, projectId);

      // `converted_at` is what makes this happen once — not the project, which
      // a conversion need not produce.
      const claimed = await tx
        .update(leads)
        .set({
          stage: "won",
          wonAt: now,
          lostAt: null,
          lostReason: null,
          convertedAt: now,
          projectId,
          clientId,
          updatedBy: actor.id,
        })
        .where(and(eq(leads.id, id), eq(leads.version, expectedVersion), isNull(leads.convertedAt)))
        .returning({ id: leads.id });

      if (claimed.length === 0) {
        // Either somebody else converted it while this ran, or the form was
        // composed against an older version. Both mean: nothing written.
        const [current] = await tx
          .select({ convertedAt: leads.convertedAt })
          .from(leads)
          .where(eq(leads.id, id))
          .limit(1);

        throw current?.convertedAt
          ? new Rolled("already_done", "This lead has already been converted.")
          : new Rolled("conflict", CONFLICT_MESSAGE);
      }

      await record(tx, actor, {
        action: "lead.converted",
        entityType: "lead",
        entityId: id,
        entityLabel: lead.title,
        metadata: { project_id: projectId, client_id: clientId },
      });

      return ok({ projectId, clientId });
    });
  } catch (error) {
    if (error instanceof Rolled) return refuse(error.reason, error.detail);
    throw error;
  }
}

/** The client the work belongs to: the one chosen, the one already on the lead, or a new one. */
async function resolveClient(
  tx: Tx,
  actor: AuditActor,
  lead: LeadRow,
  input: ConvertLeadInput,
): Promise<string> {
  const existingId = input.clientId ?? lead.clientId;

  if (existingId) {
    const [client] = await tx
      .select({ id: clients.id, archivedAt: clients.archivedAt })
      .from(clients)
      .where(eq(clients.id, existingId))
      .limit(1);

    if (!client) throw new Rolled("not_found", "That client no longer exists.");
    if (client.archivedAt) {
      throw new Rolled("blocked", "That client is archived. Restore it, or create a new one.");
    }
    return client.id;
  }

  const name = input.newClientName || lead.prospectName || lead.contactName || lead.title;
  const clientId = uuidv7();
  await insertClient(tx, actor, clientId, {
    accountType: input.newClientAccountType,
    name: name.slice(0, 160),
    website: null,
    domain: null,
    status: "active",
    notes: "",
  });
  return clientId;
}

/**
 * The person who has been the whole conversation so far should not have to be
 * found again once there is a client and a project. They are attached to both,
 * and named primary only where nobody has been named yet — never displacing
 * somebody already chosen.
 */
async function carryContactAcross(
  tx: Tx,
  actor: AuditActor,
  contactId: string,
  clientId: string,
  projectId: string | null,
): Promise<void> {
  const [primaryForClient] = await tx
    .select({ id: clientContacts.id })
    .from(clientContacts)
    .where(and(eq(clientContacts.clientId, clientId), eq(clientContacts.isPrimary, true)))
    .limit(1);

  const clientLink = await tx
    .insert(clientContacts)
    .values({
      id: uuidv7(),
      clientId,
      contactId,
      isPrimary: !primaryForClient,
      createdBy: actor.id,
    })
    .onConflictDoNothing({ target: [clientContacts.clientId, clientContacts.contactId] })
    .returning({ id: clientContacts.id });

  if (clientLink.length > 0) {
    await record(tx, actor, {
      action: "client_contact.attached",
      entityType: "client_contact",
      entityId: clientLink[0]!.id,
      entityLabel: "From a converted lead",
      metadata: { client_id: clientId, contact_id: contactId, primary: !primaryForClient },
    });
  }

  if (!projectId) return;

  // The project is brand new, so there is nobody to displace here.
  const projectLink = await tx
    .insert(projectContacts)
    .values({ id: uuidv7(), projectId, contactId, isPrimary: true, createdBy: actor.id })
    .returning({ id: projectContacts.id });

  await record(tx, actor, {
    action: "project_contact.attached",
    entityType: "project_contact",
    entityId: projectLink[0]!.id,
    entityLabel: "From a converted lead",
    metadata: { project_id: projectId, contact_id: contactId, primary: true },
  });
}

/** Leads attached to one client or one contact, for their detail pages. */
export async function leadsFor(
  key: { clientId?: string; contactId?: string },
  limit = 20,
): Promise<LeadRow[]> {
  const where: SQL[] = [isNull(leads.archivedAt)];
  if (key.clientId) where.push(eq(leads.clientId, key.clientId));
  if (key.contactId) where.push(eq(leads.contactId, key.contactId));
  if (where.length === 1) return [];

  return (await withNames()
    .where(and(...where))
    .orderBy(desc(leads.updatedAt))
    .limit(limit)) as LeadRow[];
}

/**
 * Inquiries nobody has decided about yet: no lead, and not put away.
 *
 * The condition is real — the absence of a lead row — rather than a flag
 * somebody has to remember to set, so this cannot quietly become wrong.
 */
export async function inquiriesAwaitingLead(limit = 5): Promise<
  { id: string; name: string; email: string; createdAt: Date }[]
> {
  return db()
    .select({
      id: inquiries.id,
      name: inquiries.name,
      email: inquiries.email,
      createdAt: inquiries.createdAt,
    })
    .from(inquiries)
    .where(
      and(
        eq(inquiries.status, "new"),
        sql`NOT EXISTS (SELECT 1 FROM leads l WHERE l.inquiry_id = inquiries.id)`,
      ),
    )
    .orderBy(desc(inquiries.createdAt))
    .limit(limit);
}

/** How many of them there are, for the figure beside the list. */
export async function countInquiriesAwaitingLead(): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(inquiries)
    .where(
      and(
        eq(inquiries.status, "new"),
        sql`NOT EXISTS (SELECT 1 FROM leads l WHERE l.inquiry_id = inquiries.id)`,
      ),
    );
  return row?.n ?? 0;
}

/** The lead an inquiry already produced, if it produced one. */
export async function leadForInquiry(inquiryId: string): Promise<{ id: string } | null> {
  const [row] = await db()
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.inquiryId, inquiryId))
    .limit(1);
  return row ?? null;
}

/** Whether a project came from a lead, for the project page. */
export async function leadForProject(projectId: string): Promise<LeadRow | null> {
  const [row] = await withNames().where(eq(leads.projectId, projectId)).limit(1);
  return (row as LeadRow | undefined) ?? null;
}
