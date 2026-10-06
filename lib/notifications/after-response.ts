import { after } from "next/server";

import { drainOnce } from "./drain.ts";

/**
 * The `AfterCommit` hook the server actions hand to the Review domain (G2).
 *
 * The domain calls it only once its transaction has committed and only when
 * it raised a notification. It schedules `drainOnce` with Next's `after()`,
 * which runs once the response has been sent — so the action's answer is
 * never waiting on a provider, and a provider failure can never become the
 * action's failure. Not awaited, by construction: there is nothing to await.
 */
export function drainAfterResponse(): void {
  after(drainOnce);
}
