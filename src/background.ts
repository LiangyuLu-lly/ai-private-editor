import "./status-worker.js";
// Registers its own message listener for neural review; kept separate because
// createBackgroundMessageHandler below only trusts the side panel.
import "./neural-host.js";

import { isFillDraftMessage, isPingMessage } from "./shared/messages.js";
import type {
  FillResponse,
  PageSiteStatusResponse,
  RuntimeMessage,
  SiteStatusResponse,
} from "./shared/types.js";

export { isFillDraftMessage } from "./shared/messages.js";

export const HONEST_NAME_NOTICE_KEY = "honestNameNoticeV1";

export async function decideWelcomeOpen(
  reason: string,
  getNotice: () => Promise<unknown>,
  markNotice: () => Promise<void>,
): Promise<"welcome" | "welcome-update" | "none"> {
  if (reason === "install") {
    await markNotice();
    return "welcome";
  }
  if (reason !== "update") {
    return "none";
  }
  if ((await getNotice()) === true) {
    return "none";
  }
  await markNotice();
  return "welcome-update";
}

export type RuntimeRelay = (message: RuntimeMessage) => Promise<FillResponse | SiteStatusResponse>;
export type RuntimeMessageSender = {
  id?: string;
  url?: string;
};
export type SidePanelSenderGuard = (sender: RuntimeMessageSender) => boolean;
type SidePanelBehaviorApi = {
  setPanelBehavior: (behavior: { openPanelOnActionClick: boolean }) => Promise<void>;
};

function isPageSiteStatusResponse(value: unknown): value is PageSiteStatusResponse {
  const response = value as { site?: unknown; bindingKey?: unknown };

  return (
    typeof value === "object" &&
    value !== null &&
    "site" in value &&
    (response.site === null ||
      ((response.site === "doubao" ||
        response.site === "deepseek" ||
        response.site === "yuanbao" ||
        response.site === "chatgpt" ||
        response.site === "claude" ||
        response.site === "gemini" ||
        response.site === "kimi" ||
        response.site === "qwen" ||
        response.site === "wenxin") &&
        typeof response.bindingKey === "string" &&
        response.bindingKey.length >= 16))
  );
}

function isFillResponse(value: unknown): value is FillResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value.ok === true || (value.ok === false && "error" in value && typeof value.error === "string"))
  );
}

async function relayToActiveTab(message: RuntimeMessage): Promise<FillResponse | SiteStatusResponse> {
  try {
    if (isPingMessage(message)) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (typeof activeTab?.id !== "number") {
        return { site: null };
      }

      const response = await chrome.tabs.sendMessage(activeTab.id, message);
      if (!isPageSiteStatusResponse(response) || response.site === null) {
        return { site: null };
      }

      return { site: response.site, tabId: activeTab.id, bindingKey: response.bindingKey };
    }

    const response = await chrome.tabs.sendMessage(message.tabId, message);
    return isFillResponse(response) ? response : { ok: false, error: "content_script_unavailable" };
  } catch {
    return isPingMessage(message) ? { site: null } : { ok: false, error: "content_script_unavailable" };
  }
}

function createChromeSidePanelSenderGuard(): SidePanelSenderGuard {
  return (sender) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.id || typeof chrome.runtime.getURL !== "function") {
      return false;
    }

    return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("sidepanel.html");
  };
}

export function createBackgroundMessageHandler(
  relay: RuntimeRelay = relayToActiveTab,
  isTrustedSidePanelSender: SidePanelSenderGuard = createChromeSidePanelSenderGuard(),
) {
  return async (message: unknown, sender: RuntimeMessageSender = {}): Promise<FillResponse | SiteStatusResponse> => {
    if ((!isPingMessage(message) && !isFillDraftMessage(message)) || !isTrustedSidePanelSender(sender)) {
      return { ok: false, error: "invalid_message" };
    }

    return relay(message);
  };
}

export async function configureActionPanel(sidePanel: SidePanelBehaviorApi): Promise<void> {
  await sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
}

const handleMessage = createBackgroundMessageHandler();

if (typeof chrome !== "undefined" && chrome.sidePanel) {
  void configureActionPanel(chrome.sidePanel).catch((error: unknown) => {
    console.error("Unable to configure side panel behavior.", error);
  });
}

/*
 * 只对自己拥有的消息接管应答通道。
 *
 * 这里原先无条件 `return true` 并对任何消息都调 `sendResponse`，包括不认识的类型——那会静默毁掉
 * 神经复核。service worker 里注册了两个 `onMessage` 监听器（这一个和 neural-host.ts 的），两个都
 * `return true` 时，Chrome 采用**第一个**调用 `sendResponse` 的结果，后来的被丢弃。而
 * `createBackgroundMessageHandler` 对非侧边栏来源的消息立即返回 `invalid_message`，神经那条要等
 * offscreen 创建加一次推理（250 ms 以上），所以每一次都是这一个先应答，内容脚本永远拿不到提示。
 *
 * 单测抓不到它：每个监听器都是隔离测的，竞争只在真实浏览器里存在。是
 * tests/browser/neural-offscreen.test.mjs 在真实 Chrome 里发现的——发布门槛存在的理由就是这个。
 *
 * 类型判定放在监听器里而不是改 `createBackgroundMessageHandler`：那个函数对**来源**不可信仍然要返回
 * `invalid_message`（这是它被测试钉住的行为），变的只是"不认识的类型不由我应答"。
 */
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isPingMessage(message) && !isFillDraftMessage(message)) {
      return false;
    }
    void handleMessage(message, sender).then(sendResponse);
    return true;
  });
}

/*
 * 首次安装打开说明页。旧用户升级时只再打开一次（?from=update），把「姓名会漏、漏了无提示」
 * 说清楚；之后的自动更新不再弹。标记写在 chrome.storage.local，打不开标签页不该影响安装。
 */
if (typeof chrome !== "undefined" && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener((details) => {
    void (async () => {
      try {
        const local = chrome.storage?.local;
        if (local === undefined) {
          return;
        }
        const decision = await decideWelcomeOpen(
          details.reason,
          async () => (await local.get(HONEST_NAME_NOTICE_KEY))[HONEST_NAME_NOTICE_KEY],
          async () => {
            await local.set({ [HONEST_NAME_NOTICE_KEY]: true });
          },
        );
        if (decision === "none") {
          return;
        }
        const path = decision === "welcome-update" ? "welcome.html?from=update" : "welcome.html";
        void chrome.tabs?.create?.({ url: chrome.runtime.getURL(path) });
      } catch (error: unknown) {
        console.error("Unable to open the first-run page.", error);
      }
    })();
  });
}
