import type { Metadata } from "next";

/**
 * The client world: everything under `/workrooms` on the public host.
 *
 * Its own layout, like Studio's and for the same reason: the public site's
 * header, footer and cursor belong to the public site, and a private room
 * should not arrive wrapped in a portfolio.
 *
 * **The title is deliberately generic and never reads a record.** Build 003
 * measured what happens otherwise: `generateMetadata` runs independently of the
 * page component, so a page whose guard refuses still produces its title, and
 * that title travels inside the refusal. A client's name in the tab of a page
 * they were just denied is exactly the leak this avoids — so nothing under here
 * generates metadata from data at all.
 *
 * `noindex, nofollow, nocache` on everything beneath, as a second layer over
 * the `Disallow: /workrooms/` in robots.txt, for crawlers that ignore it.
 */

/**
 * Nothing under here is ever static.
 *
 * Every page reads a session and returns something private to one person, so
 * prerendering one would be meaningless at best and a cached private page at
 * worst. Declaring it also keeps `next build` honest: a private page that can
 * be built without a request is a private page that is not reading one.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Workroom",
  description: "A private space from Yiddi Weller.",
  robots: { index: false, follow: false, nocache: true },
  openGraph: undefined,
  twitter: undefined,
  alternates: {},
};

export default function WorkroomsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
