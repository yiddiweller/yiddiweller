export const site = {
  name: "Yiddi Weller",
  role: "Designer",
  url: "https://yiddiweller.com",
  handle: "@yiddiweller",
  /* Search headline and browser tab: the name alone. */
  title: "Yiddi Weller",
  /* Snippet text under the Google result: the name alone. */
  description: "Yiddi Weller",
} as const;

/** Work is reached from the homepage, so the header carries Contact only. */
export const nav = [{ href: "/contact", label: "Contact" }] as const;
