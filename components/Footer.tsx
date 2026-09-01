import SocialLinks from "@/components/SocialLinks";
import { site } from "@/lib/site";

import styles from "./Footer.module.css";

export default function Footer() {
  return (
    <footer className={`page ${styles.footer}`}>
      <p className={styles.follow}>Follow us {site.handle}</p>
      <SocialLinks />
      <small className={styles.line}>© {site.name}</small>
    </footer>
  );
}
