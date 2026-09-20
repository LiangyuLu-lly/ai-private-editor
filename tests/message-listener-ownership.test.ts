import { describe, expect, it } from "vitest";

import { isFillDraftMessage, isPingMessage } from "../src/shared/messages.js";
import { isNeuralReviewRequest } from "../src/shared/neural/messages.js";

/*
 * service worker 里两个 `chrome.runtime.onMessage` 监听器不得互相抢应答通道。
 *
 * 这曾经是一个只在真实浏览器里存在的缺陷，把神经复核整条打死。`background.ts` 原先无条件
 * `return true` 并对任何消息调 `sendResponse`，包括不认识的类型；`neural-host.ts` 也 `return true`。
 * 两个都返回 true 时 Chrome 采用**第一个**调用 `sendResponse` 的结果，而
 * `createBackgroundMessageHandler` 对非侧边栏来源立即返回 `invalid_message`，神经那条要等 offscreen
 * 创建加一次推理（实测冷启动 420 ms），所以每一次都是 background 先应答，内容脚本永远拿不到提示。
 *
 * 单测抓不到它，因为每个监听器都是隔离测的；是 tests/browser/neural-offscreen.test.mjs 在真实 Chrome
 * 里发现的。这里把两个监听器"各自只认自己的消息"这条性质钉住——它是不冲突的充分条件，而且可以在
 * 没有浏览器的情况下断言。
 */

const NEURAL_REQUEST = { type: "NEURAL_REVIEW_REQUEST", requestId: "r1", text: "周妍舒昨天说过这件事" };
const PING = { type: "PING" };
// 形状必须真的能过 `isFillDraftMessage`，否则这条测试会因为构造错误而空过。
const FILL = {
  type: "FILL_DRAFT",
  outboundText: "替换后",
  bindingKey: "0123456789abcdef0123",
  tabId: 7,
  site: "deepseek",
};

/** background.ts 的监听器接管通道的条件，与那里的判断保持一致。 */
const backgroundClaims = (message: unknown): boolean => isPingMessage(message) || isFillDraftMessage(message);
/** neural-host.ts 的监听器接管通道的条件。 */
const neuralClaims = (message: unknown): boolean => isNeuralReviewRequest(message);

describe("service worker message ownership", () => {
  it("每条消息最多被一个监听器接管", () => {
    for (const message of [NEURAL_REQUEST, PING, FILL]) {
      const claims = [backgroundClaims(message), neuralClaims(message)].filter(Boolean).length;
      expect(claims, `${JSON.stringify(message)} 被 ${claims} 个监听器接管`).toBeLessThanOrEqual(1);
    }
  });

  it("神经复核请求只被神经宿主接管", () => {
    // 这一条直接对应那个缺陷：background 认领它，就会用 invalid_message 抢先应答。
    expect(neuralClaims(NEURAL_REQUEST)).toBe(true);
    expect(backgroundClaims(NEURAL_REQUEST)).toBe(false);
  });

  it("侧边栏消息只被 background 接管", () => {
    for (const message of [PING, FILL]) {
      expect(backgroundClaims(message)).toBe(true);
      expect(neuralClaims(message)).toBe(false);
    }
  });

  it("不认识的类型谁都不接管，所以不会有人代答", () => {
    // 关键点不是"返回错误"，而是"不要占用通道"。占了就会替真正的处理者答复。
    for (const message of [{ type: "SOMETHING_ELSE" }, {}, null, "PING", 42]) {
      expect(backgroundClaims(message)).toBe(false);
      expect(neuralClaims(message)).toBe(false);
    }
  });
});
