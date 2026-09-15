import Link from "next/link";

import styles from "@/app/studio/studio.module.css";

/**
 * Where you are in a list, and the two ways out of it.
 *
 * Links rather than buttons: a page of a list is a place, so it can be
 * bookmarked, shared and gone back to. Nothing is rendered at all when
 * everything already fits on one page.
 */
export default function Pager({
  path,
  params,
  page,
  total,
  pageSize,
}: {
  path: string;
  params: Record<string, string | undefined>;
  page: number;
  total: number;
  pageSize: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;

  const href = (target: number) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) query.set(key, value);
    }
    if (target > 1) query.set("page", String(target));
    const search = query.toString();
    return search ? `${path}?${search}` : path;
  };

  return (
    <nav className={styles.pager} aria-label="Pages">
      <span className={styles.pagerNote}>
        Page {page} of {pages} · {total} in total
      </span>
      <span className={styles.pagerLinks}>
        {page > 1 ? (
          <Link className={styles.buttonQuiet} href={href(page - 1)} rel="prev">
            Previous
          </Link>
        ) : null}
        {page < pages ? (
          <Link className={styles.buttonQuiet} href={href(page + 1)} rel="next">
            Next
          </Link>
        ) : null}
      </span>
    </nav>
  );
}
