import { and, asc, eq, ilike, isNull, or, type SQL } from "drizzle-orm";

import { db } from "./index.ts";
import { clients, contacts, leads, projects } from "./schema.ts";

/**
 * One search box across the business core.
 *
 * PostgreSQL does all of it, as four small indexed queries run together rather
 * than one union that the planner would have to guess at. There is no search
 * service, no index to keep in step and nothing to reindex — Studio's whole
 * corpus is a few thousand rows of short names, and `lower(name)` covers it.
 *
 * If this ever stops being fast the answer is `tsvector` in this file, not a
 * dependency.
 */

export type SearchKind = "client" | "contact" | "lead" | "project";

export type SearchHit = {
  kind: SearchKind;
  id: string;
  label: string;
  /** The line under the name: enough to tell two similar results apart. */
  detail: string | null;
  href: string;
};

/** Per kind, so one busy table cannot crowd the others out of the results. */
const PER_KIND = 5;

/** `%` and `_` are wildcards to LIKE; somebody typing them means the characters. */
function like(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export async function search(query: string): Promise<SearchHit[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  const pattern = like(term);

  const [clientHits, contactHits, leadHits, projectHits] = await Promise.all([
    db()
      .select({ id: clients.id, label: clients.name, detail: clients.domain })
      .from(clients)
      .where(
        and(
          isNull(clients.archivedAt),
          or(ilike(clients.name, pattern), ilike(clients.domain, pattern)) as SQL,
        ),
      )
      .orderBy(asc(clients.name))
      .limit(PER_KIND),

    db()
      .select({ id: contacts.id, label: contacts.name, detail: contacts.email })
      .from(contacts)
      .where(
        and(
          isNull(contacts.archivedAt),
          or(ilike(contacts.name, pattern), ilike(contacts.email, pattern)) as SQL,
        ),
      )
      .orderBy(asc(contacts.name))
      .limit(PER_KIND),

    db()
      .select({ id: leads.id, label: leads.title, detail: leads.prospectName })
      .from(leads)
      .where(
        and(
          isNull(leads.archivedAt),
          or(ilike(leads.title, pattern), ilike(leads.prospectName, pattern)) as SQL,
        ),
      )
      .orderBy(asc(leads.title))
      .limit(PER_KIND),

    db()
      .select({ id: projects.id, label: projects.name, detail: clients.name })
      .from(projects)
      .innerJoin(clients, eq(clients.id, projects.clientId))
      .where(and(isNull(projects.archivedAt), ilike(projects.name, pattern)))
      .orderBy(asc(projects.name))
      .limit(PER_KIND),
  ]);

  const hits: SearchHit[] = [
    ...clientHits.map((row) => hit("client", row, "clients")),
    ...contactHits.map((row) => hit("contact", row, "contacts")),
    ...leadHits.map((row) => hit("lead", row, "leads")),
    ...projectHits.map((row) => hit("project", row, "projects")),
  ];

  // A name that begins with what was typed is almost always the one meant.
  const lowered = term.toLowerCase();
  return hits.sort((a, b) => {
    const byPrefix =
      Number(b.label.toLowerCase().startsWith(lowered)) -
      Number(a.label.toLowerCase().startsWith(lowered));
    return byPrefix !== 0 ? byPrefix : a.label.localeCompare(b.label);
  });
}

function hit(
  kind: SearchKind,
  row: { id: string; label: string; detail: string | null },
  segment: string,
): SearchHit {
  return {
    kind,
    id: row.id,
    label: row.label,
    detail: row.detail,
    href: `/studio/${segment}/${row.id}`,
  };
}
