import type { Metadata } from "next";

import PublicFrame from "@/components/PublicFrame";
import { isPreview } from "@/lib/env";
import { site } from "@/lib/site";

/**
 * The public site: everything a visitor sees at yiddiweller.com.
 *
 * Its chrome lives here rather than in the root layout because Studio is a
 * different world and must not inherit any of it. Before this group existed,
 * the Studio shell rendered inside the public header, footer and custom
 * cursor, and its `<main>` sat nested inside the public one. A route group
 * keeps the URLs exactly as they were — `/`, `/work`, `/contact` — while
 * giving each world its own frame.
 */

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: site.name,
    title: site.title,
    description: site.description,
    url: site.url,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: site.title,
    description: site.description,
  },
  /* Second layer over robots.txt, for crawlers that ignore it. Studio states
     its own, and states it unconditionally. */
  robots: isPreview
    ? { index: false, follow: false, nocache: true }
    : {
        index: true,
        follow: true,
        googleBot: { index: true, follow: true, "max-image-preview": "large" },
      },
};

const personSchema = {
  "@context": "https://schema.org",
  "@type": "Person",
  name: site.name,
  url: site.url,
  jobTitle: site.role,
  description: site.description,
  image: `${site.url}/icon-512.png`,
};

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(personSchema) }}
      />
      <PublicFrame>{children}</PublicFrame>
    </>
  );
}
