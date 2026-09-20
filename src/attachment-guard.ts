import type { AttachmentAction } from "./shared/types.js";

export type AttachmentDecision = {
  action: AttachmentAction;
  count: number;
  /** The current page cannot prove that there are no attachments. */
  unverified?: true;
};

export function getAttachmentDecision(
  action: AttachmentAction,
  attachments: readonly Element[],
  attachmentState: "scoped" | "unavailable" = "scoped",
): AttachmentDecision {
  if (attachmentState === "unavailable") {
    return action === "confirm" || action === "block"
      ? { action, count: 0, unverified: true }
      : { action: "allow", count: 0, unverified: true };
  }

  return attachments.length === 0 ? { action: "allow", count: 0 } : { action, count: attachments.length };
}
