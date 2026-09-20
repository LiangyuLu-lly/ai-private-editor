/*
 * Service-worker side of neural review: own the offscreen document, relay requests to it.
 *
 * Registered as its own `chrome.runtime.onMessage` listener rather than folded into
 * `createBackgroundMessageHandler`, because that handler only trusts the side panel and
 * answers everything else with `invalid_message`. These requests come from content scripts.
 *
 * The service worker is torn down when idle and the offscreen document is not, so
 * `ensureOffscreenDocument` has to tolerate the document already existing after a worker
 * restart — `createDocument` throws in that case rather than succeeding quietly.
 */

import {
  NEURAL_REVIEW_EXEC,
  NEURAL_REVIEW_RESULT,
  isNeuralReviewRequest,
  type NeuralReviewExec,
  type NeuralReviewResult,
} from "./shared/neural/messages.js";
import { publishNeuralRuntimeStatus } from "./shared/neural/runtime-status.js";

const OFFSCREEN_PATH = "offscreen.html";

type OffscreenApi = {
  hasDocument?: () => Promise<boolean>;
  createDocument: (options: { url: string; reasons: string[]; justification: string }) => Promise<void>;
};

export type NeuralHostHandlerOptions = {
  readonly timeoutMilliseconds?: number;
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
};

let creating: Promise<void> | null = null;

export async function ensureOffscreenDocument(offscreen: OffscreenApi): Promise<void> {
  if (await offscreen.hasDocument?.()) {
    return;
  }
  if (creating !== null) {
    await creating;
    return;
  }
  creating = offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      // WORKERS is the reason that matches "run sustained computation off the worker".
      reasons: ["WORKERS"],
      justification: "在本地运行语义模型，草稿文本不离开浏览器。",
    })
    .catch((error: unknown) => {
      // A concurrent creation from another request wins the race; that is success, not failure.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Only a single offscreen")) {
        throw error;
      }
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

export function createNeuralHostHandler(
  offscreen: OffscreenApi,
  send: (message: NeuralReviewExec) => Promise<unknown>,
  /**
   * 把运行时状态发布出去，供设置页读取。可注入，默认走 `chrome.storage.session`。
   *
   * 发布点在 service worker 而不是 offscreen 文档里，理由不只是"能跑通"：这里本来就中转每一次复核、
   * 也拥有 offscreen 文档的生命周期，所以"模型到底有没有在工作"这个事实在这里是第一手的。在真实
   * Chrome 里实测 offscreen 文档写 `storage.session` 不生效（Playwright 既不把它当 page 也不当
   * backgroundPage，很难继续观测），而 service worker 是明确受信的上下文，写入可验证。
   *
   * 为什么需要发布：`ready` 与"已启用"是两种状态。CSP 拒了 WASM 或产物没进包时，offscreen 记下
   * ready: false、缓存保持空；R9 的内容脚本会在发送时显式要求取消或确认一次原文发送，
   * 不会安静地把未复核草稿当作规则已覆盖。
   */
  publish: (status: { ready: boolean; loadMilliseconds: number | null; error: string | null }) => void =
    (status) => void publishNeuralRuntimeStatus(status),
  options: NeuralHostHandlerOptions = {},
) {
  // 只在还没拿到加载耗时时去问一次。问 offscreen 不触发推理，但每次复核都问一遍是白花的往返。
  let loadMilliseconds: number | null = null;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
  const setTimer = options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  return async (message: unknown): Promise<NeuralReviewResult | null> => {
    if (!isNeuralReviewRequest(message)) {
      return null;
    }
    let cancelled = false;
    let timeoutHandle: unknown = null;
    try {
      await ensureOffscreenDocument(offscreen);
      const reply = await new Promise<unknown>((resolve, reject) => {
        timeoutHandle = setTimer(() => {
          cancelled = true;
          reject(new Error("neural review timeout"));
        }, timeoutMilliseconds);
        void send({
          type: NEURAL_REVIEW_EXEC,
          requestId: message.requestId,
          text: message.text,
        }).then(
          (value) => {
            if (cancelled) {
              return;
            }
            if (timeoutHandle !== null) {
              clearTimer(timeoutHandle);
              timeoutHandle = null;
            }
            resolve(value);
          },
          (error: unknown) => {
            if (cancelled) {
              return;
            }
            if (timeoutHandle !== null) {
              clearTimer(timeoutHandle);
              timeoutHandle = null;
            }
            reject(error);
          },
        );
      });
      // The offscreen document already validated and shaped this; passing it through unchanged
      // keeps one place responsible for the contract. The content script validates on arrival.
      const result = reply as NeuralReviewResult;
      if (result?.ok === true && loadMilliseconds === null && typeof result.elapsedMs === "number") {
        // 首次成功的那一次里，elapsedMs 包含了冷启动，是"加载花了多久"最接近的可得值。
        loadMilliseconds = result.elapsedMs;
      }
      publish({
        ready: result?.ok === true,
        loadMilliseconds,
        error: result?.ok === false ? result.error : null,
      });
      return result;
    } catch (error: unknown) {
      const failure = error instanceof Error ? error.message : String(error);
      publish({ ready: false, loadMilliseconds, error: failure });
      return {
        type: NEURAL_REVIEW_RESULT,
        requestId: message.requestId,
        ok: false,
        error: failure,
      };
    } finally {
      if (timeoutHandle !== null) {
        clearTimer(timeoutHandle);
      }
    }
  };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  const handle = createNeuralHostHandler(
    chrome.offscreen as unknown as OffscreenApi,
    (message) => chrome.runtime.sendMessage(message),
  );
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only our own extension's contexts may ask for a review.
    if (sender.id !== chrome.runtime.id || !isNeuralReviewRequest(message)) {
      return false;
    }
    void handle(message).then(sendResponse);
    return true;
  });
}
