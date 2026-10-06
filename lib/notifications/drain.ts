import { dispatchDue, IMMEDIATE_BATCH } from "./dispatch.ts";
import { logNotification } from "./log.ts";

/**
 * The best-effort drain (G2): one small pass of the **same** dispatcher, run
 * after a Review action has committed, so a notification usually leaves
 * within seconds rather than at the next scheduled run.
 *
 * **Speed only — never the guarantee.** The guarantee is the row the action's
 * own transaction wrote and the scheduled `npm run notifications:dispatch`
 * that will find it. If this never runs — the process is stopped, the
 * deploy rolls, the database is briefly unreachable — nothing is lost: the
 * row is still `pending` and the next scheduled pass delivers it.
 *
 * It never rejects. Whatever goes wrong is one field-less warning; the
 * action it follows has already succeeded and is never told.
 */
export async function drainOnce(): Promise<void> {
  try {
    await dispatchDue({ limit: IMMEDIATE_BATCH });
  } catch {
    logNotification("notification.drain_failed", {});
  }
}
