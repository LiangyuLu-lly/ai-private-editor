import {
  isProtectionStatusMessage,
  type ReplyViewerDiagnostics,
  type ProtectionStatus,
} from "./shared/protection-status.js";

const DEFAULT_TITLE = "管理自定义敏感词";

export type ToolbarActionApi = {
  setBadgeText(details: { text: string; tabId: number }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string; tabId: number }): Promise<void>;
  setBadgeTextColor(details: { color: string; tabId: number }): Promise<void>;
  setTitle(details: { title: string; tabId: number }): Promise<void>;
};

export type ToolbarPresentation = {
  badgeText: string;
  badgeBackgroundColor?: string;
  badgeTextColor?: string;
  title: string;
};

function replyViewerTitle(diagnostics: ReplyViewerDiagnostics): string {
  switch (diagnostics.state) {
    case "waiting_for_reply":
      return "回复令牌查看：未识别助手回复区域";
    case "no_tokens":
      return `回复令牌查看：已识别 ${diagnostics.containers} 个回复区域，暂无可查看令牌`;
    case "ready":
      return `回复令牌查看：已绑定 ${diagnostics.tokens} 个令牌`;
    case "disabled":
      return "回复令牌查看：未启用";
  }
}

export type ToolbarStatusSender = {
  tabId?: number;
  documentId?: string;
};

export type NavigationChange = {
  status?: string;
  url?: string;
};

export type ToolbarStatusHandlers = {
  handleStatus(message: unknown, sender: ToolbarStatusSender): Promise<void>;
  resetForNavigation(tabId: number, changeInfo: NavigationChange): Promise<void>;
  forgetTab(tabId: number): void;
};

type TabStatusState = {
  generation: number;
  currentDocumentId?: string;
  staleDocumentIds: Set<string>;
};

export function getToolbarPresentation(status: ProtectionStatus): ToolbarPresentation {
  switch (status.state) {
    case "protected": {
      const presentation: ToolbarPresentation = {
        badgeText: "ON",
        badgeBackgroundColor: "#15803d",
        badgeTextColor: "#ffffff",
        title: "AI 私密编辑：当前页面已保护",
      };
      if (status.replyViewer !== undefined) {
        presentation.title += `；${replyViewerTitle(status.replyViewer)}`;
      }
      return presentation;
    }
    case "unverified": {
      const presentation: ToolbarPresentation = {
        badgeText: "!",
        badgeBackgroundColor: "#b45309",
        badgeTextColor: "#ffffff",
        title: "AI 私密编辑：当前页面未验证，按网页原生方式发送",
      };
      if (status.replyViewer !== undefined) {
        presentation.title += `；${replyViewerTitle(status.replyViewer)}`;
      }
      return presentation;
    }
    case "checking": {
      const presentation: ToolbarPresentation = {
        badgeText: "",
        title: "AI 私密编辑：正在检查此页面",
      };
      if (status.replyViewer !== undefined) {
        presentation.title += `；${replyViewerTitle(status.replyViewer)}`;
      }
      return presentation;
    }
  }
}

async function applyToolbarPresentation(
  action: ToolbarActionApi,
  tabId: number,
  presentation: ToolbarPresentation,
): Promise<void> {
  await action.setBadgeText({ text: presentation.badgeText, tabId });

  if (presentation.badgeBackgroundColor !== undefined && presentation.badgeTextColor !== undefined) {
    await action.setBadgeBackgroundColor({ color: presentation.badgeBackgroundColor, tabId });
    await action.setBadgeTextColor({ color: presentation.badgeTextColor, tabId });
  }

  await action.setTitle({ title: presentation.title, tabId });
}

export function createToolbarStatusHandlers(action: ToolbarActionApi): ToolbarStatusHandlers {
  const tails = new Map<number, Promise<void>>();
  const tabStates = new Map<number, TabStatusState>();

  const getTabState = (tabId: number): TabStatusState => {
    const existing = tabStates.get(tabId);
    if (existing !== undefined) {
      return existing;
    }

    const state: TabStatusState = {
      generation: 0,
      staleDocumentIds: new Set<string>(),
    };
    tabStates.set(tabId, state);
    return state;
  };

  const enqueue = (tabId: number, operation: () => Promise<void>): Promise<void> => {
    const previous = tails.get(tabId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    tails.set(tabId, pending);
    void pending.then(
      () => {
        if (tails.get(tabId) === pending) {
          tails.delete(tabId);
        }
      },
      () => {
        if (tails.get(tabId) === pending) {
          tails.delete(tabId);
        }
      },
    );
    return pending;
  };

  return {
    handleStatus(message, sender) {
      if (
        !isProtectionStatusMessage(message) ||
        typeof sender.tabId !== "number" ||
        typeof sender.documentId !== "string" ||
        sender.documentId.length === 0
      ) {
        return Promise.resolve();
      }

      const { tabId, documentId } = sender;
      const tabState = getTabState(tabId);
      if (
        tabState.staleDocumentIds.has(documentId) ||
        (tabState.currentDocumentId !== undefined && tabState.currentDocumentId !== documentId)
      ) {
        return Promise.resolve();
      }

      tabState.currentDocumentId = documentId;
      const generation = tabState.generation;
      const presentation = getToolbarPresentation(message.status);

      return enqueue(tabId, async () => {
        const currentState = tabStates.get(tabId);
        if (
          currentState === undefined ||
          currentState.generation !== generation ||
          currentState.currentDocumentId !== documentId
        ) {
          return;
        }

        await applyToolbarPresentation(action, tabId, presentation);
      });
    },
    resetForNavigation(tabId, changeInfo) {
      const startsDocumentNavigation = changeInfo.status === "loading";
      if (!startsDocumentNavigation && typeof changeInfo.url !== "string") {
        return Promise.resolve();
      }

      if (startsDocumentNavigation) {
        const tabState = getTabState(tabId);
        if (tabState.currentDocumentId !== undefined) {
          tabState.staleDocumentIds.add(tabState.currentDocumentId);
        }
        tabState.currentDocumentId = undefined;
        tabState.generation += 1;
      }

      return enqueue(tabId, async () => {
        await action.setBadgeText({ text: "", tabId });
        await action.setTitle({ title: DEFAULT_TITLE, tabId });
      });
    },
    forgetTab(tabId) {
      tails.delete(tabId);
      tabStates.delete(tabId);
    },
  };
}

export function createToolbarStatusHandler(action: ToolbarActionApi) {
  return createToolbarStatusHandlers(action).handleStatus;
}

export function createNavigationStatusResetter(action: ToolbarActionApi) {
  return createToolbarStatusHandlers(action).resetForNavigation;
}

function createChromeToolbarActionApi(): ToolbarActionApi {
  return {
    setBadgeText: (details) => chrome.action.setBadgeText(details),
    setBadgeBackgroundColor: (details) => chrome.action.setBadgeBackgroundColor(details),
    setBadgeTextColor: (details) => chrome.action.setBadgeTextColor(details),
    setTitle: (details) => chrome.action.setTitle(details),
  };
}

function registerStatusWorker(): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage || !chrome.action) {
    return;
  }

  const action = createChromeToolbarActionApi();
  const { handleStatus, resetForNavigation, forgetTab } = createToolbarStatusHandlers(action);

  chrome.runtime.onMessage.addListener((message, sender) => {
    void handleStatus(message, {
      tabId: sender.tab?.id,
      documentId: sender.documentId,
    }).catch(() => undefined);
  });

  chrome.tabs?.onUpdated.addListener((tabId, changeInfo) => {
    void resetForNavigation(tabId, changeInfo).catch(() => undefined);
  });

  chrome.tabs?.onRemoved.addListener((tabId) => {
    forgetTab(tabId);
  });
}

registerStatusWorker();
