import { afterEach, describe, expect, it } from "vitest";

import { createSensitiveSendConfirmation } from "../src/sensitive-confirmation.js";
import type { RedactionFinding, SensitiveActionDecision } from "../src/shared/types.js";

const phoneFinding: RedactionFinding = { kind: "phone", decision: "replace", count: 1 };
const emailFinding: RedactionFinding = { kind: "email", decision: "replace", count: 2 };

let confirmation: ReturnType<typeof createSensitiveSendConfirmation> | undefined;

afterEach(() => {
  confirmation?.dispose();
  confirmation = undefined;
  document.body.replaceChildren();
});

async function expectStillPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
}

function dialog(): HTMLElement | null {
  return document.getElementById("privacy-composer-confirmation");
}

function clickAction(action: string): void {
  document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.click();
}

describe("sensitive confirmation queue", () => {
  it("queues a second request instead of resolving cancel", async () => {
    confirmation = createSensitiveSendConfirmation(document);

    const firstRequest = confirmation.request([phoneFinding]);
    const secondRequest = confirmation.request([emailFinding]);
    let secondRequestDecision: SensitiveActionDecision | undefined;
    void secondRequest.then((decision) => {
      secondRequestDecision = decision;
    });

    expect(document.querySelectorAll("#privacy-composer-confirmation")).toHaveLength(1);
    expect(dialog()?.textContent).toContain("1 项");
    expect(dialog()?.textContent).not.toContain("13800138000");
    await expectStillPending(secondRequest);
    expect(secondRequestDecision).not.toBe("cancel");

    clickAction("redact");
    await expect(firstRequest).resolves.toBe("redact");
    expect(secondRequestDecision).toBeUndefined();
    expect(document.querySelectorAll("#privacy-composer-confirmation")).toHaveLength(1);
    expect(dialog()?.textContent).toContain("2 项");
    expect(dialog()?.textContent).not.toContain("1 项");
    expect(dialog()?.textContent).not.toContain("user@example.com");

    expect(dialog()?.textContent).toContain("未列出的姓名不会提示");
    clickAction("raw-once");
    await expectStillPending(secondRequest);
    expect(dialog()?.querySelector('[data-action="raw-once"]')?.textContent).toContain("再点一次");
    clickAction("raw-once");
    await expect(secondRequest).resolves.toBe("raw_once");
    expect(dialog()).toBeNull();

    confirmation.dispose();
    document.body.replaceChildren();
    confirmation = createSensitiveSendConfirmation(document);

    const firstUnreviewed = confirmation.requestUnreviewed("reason-one", "send");
    const secondUnreviewed = confirmation.requestUnreviewed("reason-two", "paste");
    let secondUnreviewedDecision: boolean | undefined;
    void secondUnreviewed.then((decision) => {
      secondUnreviewedDecision = decision;
    });

    expect(document.querySelectorAll("#privacy-composer-confirmation")).toHaveLength(1);
    expect(dialog()?.textContent).toContain("reason-one");
    await expectStillPending(secondUnreviewed);
    expect(secondUnreviewedDecision).not.toBe(false);

    clickAction("cancel-unreviewed");
    await expect(firstUnreviewed).resolves.toBe(false);
    expect(secondUnreviewedDecision).toBeUndefined();
    expect(document.querySelectorAll("#privacy-composer-confirmation")).toHaveLength(1);
    expect(dialog()?.textContent).toContain("reason-two");
    expect(dialog()?.querySelector('[data-action="cancel-unreviewed"]')?.textContent).toBe("取消粘贴");
    expect(dialog()?.querySelector('[data-action="raw-unreviewed-once"]')?.textContent).toBe("仅本次按原文粘贴");

    clickAction("raw-unreviewed-once");
    await expectStillPending(secondUnreviewed);
    expect(dialog()?.querySelector('[data-action="raw-unreviewed-once"]')?.textContent).toContain("再点一次");
    clickAction("raw-unreviewed-once");
    await expect(secondUnreviewed).resolves.toBe(true);
    expect(dialog()).toBeNull();

    confirmation.dispose();
    document.body.replaceChildren();
    confirmation = createSensitiveSendConfirmation(document);

    const firstAttachment = confirmation.requestAttachment();
    const secondAttachment = confirmation.requestAttachment(true);
    let secondAttachmentDecision: boolean | undefined;
    void secondAttachment.then((decision) => {
      secondAttachmentDecision = decision;
    });

    expect(document.querySelectorAll("#privacy-composer-confirmation")).toHaveLength(1);
    expect(dialog()?.querySelector('[data-action="confirm-attachment"]')?.textContent).toBe("继续检查并发送");
    await expectStillPending(secondAttachment);
    expect(secondAttachmentDecision).not.toBe(false);

    clickAction("cancel-attachment");
    await expect(firstAttachment).resolves.toBe(false);
    expect(secondAttachmentDecision).toBeUndefined();
    expect(document.querySelectorAll("#privacy-composer-confirmation")).toHaveLength(1);
    expect(dialog()?.querySelector('[data-action="confirm-attachment"]')?.textContent).toBe("仅本次继续发送");

    clickAction("confirm-attachment");
    await expect(secondAttachment).resolves.toBe(true);
    expect(dialog()).toBeNull();
  });
});
