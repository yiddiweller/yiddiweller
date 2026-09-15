import type { Metadata } from "next";

/**
 * Wraps everything under /studio, signed in or not.
 *
 * Studio is never indexed. That is stated here rather than relying on the beta
 * preview guard, because this has to hold on the production Studio host too,
 * where SITE_ENV is not set. The sitemap lists public routes only, so Studio
 * appears in neither.
 */
export const metadata: Metadata = {
  title: { default: "Studio", template: "%s — Studio" },
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Nothing under Studio may be cached or prerendered: every page is a view of
 * one signed-in person's private data.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function StudioRootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
