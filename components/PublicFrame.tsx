import Cursor from "@/components/Cursor";
import Footer from "@/components/Footer";
import Header from "@/components/Header";
import HeaderFade from "@/components/HeaderFade";

/**
 * The public site's frame: header, footer, cursor, and the one `<main>`.
 *
 * It is a component rather than only a layout because `app/not-found.tsx`
 * renders inside the root layout, not inside the `(public)` group's, and an
 * unmatched URL should still arrive at a page that looks like the site.
 */
export default function PublicFrame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <Header />
      <HeaderFade />
      <main id="main">{children}</main>
      <Footer />
      <Cursor />
    </>
  );
}
