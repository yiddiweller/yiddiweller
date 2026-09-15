import Link from "next/link";

import ContactFields from "@/components/studio/ContactFields";
import FormDialog from "@/components/studio/FormDialog";
import Moment from "@/components/studio/Moment";
import Pager from "@/components/studio/Pager";
import { requireStaff } from "@/lib/auth/guard";
import { LIMITS, PAGE_SIZE, readPage, text } from "@/lib/business";
import { listContacts } from "@/lib/db/contacts";
import styles from "@/app/studio/studio.module.css";

import { createContactAction } from "./actions";

export const metadata = { title: "Contacts" };

/**
 * The people.
 *
 * A contact belongs to nobody: the same person can be related to several
 * clients and several projects without being duplicated, which is why this is
 * its own list rather than a section inside each client.
 */
export default async function StudioContacts({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; archived?: string; page?: string }>;
}) {
  await requireStaff();

  const params = await searchParams;
  const query = text(params.q, LIMITS.search);
  const archived = params.archived === "archived" ? "archived" : "active";
  const page = readPage(params.page);

  const { rows, total } = await listContacts({
    query: query || undefined,
    archived,
    page,
    pageSize: PAGE_SIZE,
  });

  return (
    <>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <p className={styles.eyebrow}>
            {total} {total === 1 ? "person" : "people"}
            {archived === "archived" ? " archived" : ""}
          </p>
          <h1 className={styles.pageTitle}>Contacts</h1>
        </div>
        <div className={styles.pageActions}>
          <FormDialog
            trigger="New contact"
            title="New contact"
            note="A person. Who they are to a client is set on the client."
            submitLabel="Add contact"
            busyLabel="Adding"
            action={createContactAction}
          >
            <ContactFields id="new-contact" />
          </FormDialog>
        </div>
      </div>

      <div className={styles.sections}>
        <section className={styles.section}>
          <form className={styles.filters} method="get" action="/studio/contacts">
            <div className={`${styles.filterField} ${styles.filterWide}`}>
              <label className={styles.label} htmlFor="contacts-q">
                Search
              </label>
              <input
                id="contacts-q"
                name="q"
                type="search"
                defaultValue={query}
                maxLength={LIMITS.search}
                placeholder="Name, email or phone"
                className={styles.input}
              />
            </div>

            {archived === "archived" ? <input type="hidden" name="archived" value="archived" /> : null}

            <button type="submit" className={styles.buttonSecondary}>
              Filter
            </button>
          </form>

          <div className={styles.chips}>
            <Link
              className={`${styles.chip} ${archived === "active" ? styles.chipActive : ""}`}
              href={`/studio/contacts${query ? `?q=${encodeURIComponent(query)}` : ""}`}
            >
              Active
            </Link>
            <Link
              className={`${styles.chip} ${archived === "archived" ? styles.chipActive : ""}`}
              href={`/studio/contacts?archived=archived${query ? `&q=${encodeURIComponent(query)}` : ""}`}
            >
              Archived
            </Link>
          </div>

          {rows.length === 0 ? (
            <p className={styles.empty}>
              {query
                ? "Nobody matches that."
                : archived === "archived"
                  ? "Nobody has been archived."
                  : "No contacts yet. They usually arrive with an inquiry."}
            </p>
          ) : (
            <ul className={`${styles.list} ${styles.listFourUp}`}>
              {rows.map((contact) => (
                <li key={contact.id} className={`${styles.row} ${contact.archivedAt ? styles.rowMuted : ""}`}>
                  <span className={styles.rowPrimary}>
                    <Link className={styles.rowLink} href={`/studio/contacts/${contact.id}`}>
                      {contact.name}
                    </Link>
                  </span>
                  <span className={styles.rowSecondary}>
                    {contact.email ? (
                      <a className={styles.rowLink} href={`mailto:${contact.email}`}>
                        {contact.email}
                      </a>
                    ) : (
                      (contact.phone ?? "—")
                    )}
                  </span>
                  <span className={styles.rowMeta}>
                    {contact.clientCount > 0 ? (
                      <span className={styles.tag}>
                        {contact.clientCount} {contact.clientCount === 1 ? "client" : "clients"}
                      </span>
                    ) : null}
                    {contact.projectCount > 0 ? (
                      <span className={styles.tag}> {contact.projectCount} live</span>
                    ) : null}
                  </span>
                  <Moment className={styles.rowMeta} iso={contact.updatedAt.toISOString()} style="day" />
                </li>
              ))}
            </ul>
          )}

          <Pager
            path="/studio/contacts"
            params={{ q: query, archived: archived === "archived" ? "archived" : undefined }}
            page={page}
            total={total}
            pageSize={PAGE_SIZE}
          />
        </section>
      </div>
    </>
  );
}
