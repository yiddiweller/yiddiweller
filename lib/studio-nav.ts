/**
 * Studio's navigation, as data.
 *
 * Grouped in its shape and flat in its rendering: a group's label appears only
 * once there is more than one group, so today's three items show no headings
 * and Build 003 can add a second group without any layout work.
 *
 * Only areas that exist appear here. A greyed-out module for something
 * unbuilt is dead navigation, and Studio has none.
 */

export type StudioNavItem = { href: string; label: string };
export type StudioNavGroup = { label: string; items: StudioNavItem[] };

export const STUDIO_NAV: StudioNavGroup[] = [
  {
    label: "Studio",
    items: [
      { href: "/studio", label: "Home" },
      { href: "/studio/team", label: "Team" },
      { href: "/studio/settings", label: "Settings" },
    ],
  },
];

/** Which item a path belongs to. `/studio` matches only itself; the rest match their subtrees. */
export function isCurrent(href: string, pathname: string): boolean {
  return href === "/studio" ? pathname === "/studio" : pathname.startsWith(href);
}
