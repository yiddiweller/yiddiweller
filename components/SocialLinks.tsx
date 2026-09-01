import { brandIcons } from "@/components/BrandIcons";
import { social } from "@/lib/social";

import styles from "./SocialLinks.module.css";

export default function SocialLinks() {
  return (
    <ul className={styles.list}>
      {social.map((item) => {
        const icon = brandIcons[item.key];
        return (
          <li key={item.key}>
            <a
              className={styles.link}
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={item.label}
            >
              <svg
                className={styles.icon}
                viewBox={icon.viewBox}
                fill="currentColor"
                aria-hidden="true"
                focusable="false"
              >
                {icon.art}
              </svg>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
