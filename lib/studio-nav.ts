import { type StaffRole } from "./db/schema.ts";

/**
 * Studio's navigation, as data.
 *
 * Two groups now: the business the studio runs, and the studio itself. The
 * group labels appear because there is more than one group — with a single
 * group they are noise, so they stay hidden until they mean something.
 *
 * Only areas that exist appear here. A greyed-out module for something unbuilt
 * is dead navigation, and Studio has none. An item somebody's role cannot reach
 * is not shown to them either: a link that answers "not found" is worse than no
 * link at all.
 */

export type StudioNavItem = { href: string; label: string; ownerOnly?: boolean };
export type StudioNavGroup = { label: string; items: StudioNavItem[] };

export const STUDIO_NAV: StudioNavGroup[] = [
  {
    label: "Business",
    items: [
      { href: "/studio", label: "Home" },
      { href: "/studio/clients", label: "Clients" },
      { href: "/studio/contacts", label: "Contacts" },
      { href: "/studio/leads", label: "Leads" },
      { href: "/studio/projects", label: "Projects" },
    ],
  },
  {
    label: "Delivery",
    items: [{ href: "/studio/workrooms", label: "Workrooms" }],
  },
  {
    label: "Studio",
    items: [
      { href: "/studio/search", label: "Search" },
      { href: "/studio/team", label: "Team" },
      { href: "/studio/audit", label: "Audit", ownerOnly: true },
      { href: "/studio/settings", label: "Settings" },
    ],
  },
];

/** The navigation as one role sees it. Never the security boundary — the pages are. */
export function navFor(role: StaffRole): StudioNavGroup[] {
  if (role === "owner") return STUDIO_NAV;
  return STUDIO_NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.ownerOnly),
  }));
}

/** Which item a path belongs to. `/studio` matches only itself; the rest match their subtrees. */
export function isCurrent(href: string, pathname: string): boolean {
  return href === "/studio" ? pathname === "/studio" : pathname.startsWith(href);
}
