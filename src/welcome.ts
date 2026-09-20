/*
 * 首次安装时打开的页面。
 *
 * 存在的理由不是欢迎，是知情同意。这一轮把默认档从 conservative + 语义审查关闭改成了
 * balanced + local_neural，因为旧默认会让 81.2% 的含敏感信息消息原样发出去，而随包分发的
 * 12 MB 模型完全不生效（`appendSemanticCandidates` 在 conservative 档早返回、`semanticReview`
 * 又是 off），并且要打开它得先改档位、下拉框才解禁、再选一次。
 *
   * 改默认可以，改了不说不行。这一页把打开的是哪一档、姓名会漏、漏了无提示讲清楚，并给一键调低。
   * 不要把旧 R8 盲测百分比当成当前 R9 承诺。
 *
 * 安装打开 welcome.html；旧用户升级只再打开一次 welcome.html?from=update，见 src/background.ts。
 */

import {
  FEWER_PROMPTS_SETTINGS,
  createChromeCustomTermsStore,
  type AdvancedSettings,
} from "./shared/custom-terms.js";

const fewerPromptsButton = document.querySelector<HTMLButtonElement>("#fewer-prompts");
const keepDefaultButton = document.querySelector<HTMLButtonElement>("#keep-default");
const dismissUpdateButton = document.querySelector<HTMLButtonElement>("#dismiss-update");
const updateBanner = document.querySelector<HTMLElement>("#update-banner");
const status = document.querySelector<HTMLParagraphElement>("#choice-status");
const store = createChromeCustomTermsStore();
const fromUpdate = new URLSearchParams(window.location.search).get("from") === "update";

if (fromUpdate) {
  if (updateBanner !== null) {
    updateBanner.hidden = false;
  }
  if (dismissUpdateButton !== null) {
    dismissUpdateButton.hidden = false;
  }
}

function report(message: string, state: "success" | "error"): void {
  if (status === null) {
    return;
  }
  status.textContent = message;
  status.dataset.state = state;
}

function lock(disabled: boolean): void {
  for (const button of [fewerPromptsButton, keepDefaultButton]) {
    if (button !== null) {
      button.disabled = disabled;
    }
  }
}

/**
 * 写入用户在这一页上的选择。
 *
 * 两个按钮都写盘，"保持推荐设置"也写。默认值只有在存储里**没有**这一项时才生效，所以不写的话
 * 将来再改默认会静默改变这位用户的行为——而他刚刚在这一页上明确选了当前这套。显式落盘把它
 * 变成用户的决定，不是我们的默认。
 */
async function persist(choice: Partial<AdvancedSettings>, successMessage: string): Promise<void> {
  lock(true);
  try {
    const result = await store.setAdvancedSettings(choice);
    report(result.ok ? successMessage : "保存失败，可在设置页手动调整。", result.ok ? "success" : "error");
  } catch (error: unknown) {
    report(`保存失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    lock(false);
  }
}

fewerPromptsButton?.addEventListener("click", () => {
  void persist(
    {
      detectionProfile: FEWER_PROMPTS_SETTINGS.detectionProfile,
      semanticReview: FEWER_PROMPTS_SETTINGS.semanticReview,
    },
    "已改成更少提示：不再跑模型。没有提示词的人名几乎不会提示。",
  );
});

keepDefaultButton?.addEventListener("click", () => {
  void persist(
    {
      detectionProfile: "balanced",
      semanticReview: "local_neural",
    },
    "已保持推荐设置。之后可以在设置里随时调整。",
  );
});

dismissUpdateButton?.addEventListener("click", () => {
  window.close();
});
