export const site = {
  name: "Yiddi Weller",
  role: "Designer",
  url: "https://yiddiweller.com",
  handle: "@yiddiweller",
  title: "Yiddi Weller — Designer",
  description:
    "Independent designer working across digital, physical and spatial design.",
} as const;

/** Work is reached from the homepage, so the header carries Contact only. */
export const nav = [{ href: "/contact", label: "Contact" }] as const;
