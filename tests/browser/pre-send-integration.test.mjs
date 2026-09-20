import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { launchWithExtension, repositoryRoot, waitFor } from "./launch-extension.mjs";

const FIXTURE_URL = "https://chatgpt.com/privacy-local-send-fixture";
const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>
  <form><div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"></div>
  <button id="composer-submit-button" data-testid="send-button" type="submit">发送</button></form>
  <script>
    window.submissions = [];
    const editor = document.querySelector('#prompt-textarea');
    document.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      window.submissions.push(editor.innerText);
      editor.textContent = '';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        document.querySelector('button').click();
      }
    });
  </script></body></html>`;

let launched;
let popup;
const errors = [];

async function openComposer(test) {
  const page = await launched.context.newPage();
  test.after(async () => page.close());
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_URL);
  const tabId = await popup.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    return tabs.at(-1)?.id;
  }, FIXTURE_URL);
  assert.ok(Number.isInteger(tabId), "The isolated fixture tab must be observable to the extension");
  const ready = await waitFor(async () => {
    try {
      return await popup.evaluate(async (id) => chrome.tabs.sendMessage(id, { type: "PING" }), tabId);
    } catch {
      return null;
    }
  });
  assert.equal(ready?.site, "chatgpt", "The real content script must be active before submission");
  return page;
}

async function submit(page, text, gesture = "click") {
  const prior = await page.evaluate(() => window.submissions.length);
  await page.getByRole("textbox").fill(text);
  if (gesture === "enter") {
    await page.getByRole("textbox").press("Enter");
  } else {
    await page.getByRole("button", { name: "发送", exact: true }).click();
  }
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("The isolated submit page stopped responding")), 8000);
  });
  const result = await Promise.race([deadline, waitFor(async () => page.evaluate((count) => {
    if (window.submissions.length > count) return { text: window.submissions[count], count: window.submissions.length };
    const dialog = document.querySelector('#privacy-composer-confirmation');
    if (dialog) return { confirmation: true, categories: dialog.querySelector('ul')?.innerText };
    return null;
  }, prior))]).finally(() => clearTimeout(timer));
  assert.ok(result, "A reviewed send or explicit confirmation must finish within the timeout");
  assert.equal(result.confirmation, undefined, `Unexpected confirmation: ${result.categories}`);
  assert.equal(result.count, prior + 1, "A single send gesture must submit exactly once");
  return result.text;
}

describe("真实 Chrome 受控页面发送链路（非登录态网站验收）", () => {
  before(async () => {
    launched = await launchWithExtension({
      port: 9235,
      distDirectory: process.env.PRIVATE_COMPOSER_TEST_DIST ?? resolve(repositoryRoot, "dist"),
    });
    launched.context.setDefaultTimeout(8000);
    launched.context.setDefaultNavigationTimeout(8000);
    await launched.context.route(/^https?:\/\//, async (route) => {
      if (route.request().url() === FIXTURE_URL) {
        await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HTML });
      } else {
        await route.abort();
      }
    });
    popup = await launched.context.newPage();
    await popup.goto(`chrome-extension://${launched.extensionId}/popup.html`);
    await popup.evaluate(async () => chrome.storage.local.set({ customTerms: {
      terms: [], mode: "replace", allowlistedTerms: [], categoryPolicies: [],
      detectionProfile: "balanced", replacementStyle: "token", semanticReview: "local_neural",
      attachmentAction: "warn",
    } }));
  });

  after(async () => {
    if (launched) await launched.close();
    assert.deepEqual(errors, [], "The fixture must not hide page errors");
  });

  it("点击发送前自动替换显式人名、手机号和邮箱", async (test) => {
    const page = await openComposer(test);
    const text = "对接人：岑映岚，手机号：13900005678，邮箱：lan.qin@example.invalid。";
    const outbound = await submit(page, text);
    for (const value of ["岑映岚", "13900005678", "lan.qin@example.invalid"]) {
      assert.ok(!outbound.includes(value), `The synthetic value ${value} must not leave the composer`);
    }
    assert.match(outbound, /\[\[PHONE_\d{3}\]\]/);
    await page.close();
  });

  it("回车发送前自动替换电话语境中的中文口述号码", async (test) => {
    const page = await openComposer(test);
    const outbound = await submit(page, "到时给我打电话吧，幺三八 零零零一 二三四五，下午方便。", "enter");
    assert.ok(!outbound.includes("幺三八 零零零一 二三四五"), "A complete dictated phone must not be submitted raw");
    assert.match(outbound, /\[\[PHONE_\d{3}\]\]/);
    await page.close();
  });

  it("普通工作语境中的中文口述手机号仍会替换", async (test) => {
    const page = await openComposer(test);
    const outbound = await submit(page, "测试结束后请回拨幺三九零零零零五六七八，谢谢。");
    assert.equal(outbound, "测试结束后请回拨[[PHONE_001]]，谢谢。");
    await page.close();
  });

  it("全角和零宽字符不绕过发送前替换", async (test) => {
    const page = await openComposer(test);
    const outbound = await submit(page, "请回拨 １３９\u200b００００５６７８，谢谢。", "enter");
    assert.match(outbound, /\[\[PHONE_\d{3}\]\]/);
    assert.ok(!outbound.includes("１３９"));
    await page.close();
  });

  it("同一页面重复提到手机号使用相同令牌", async (test) => {
    const page = await openComposer(test);
    const first = await submit(page, "手机号：13900005678");
    const second = await submit(page, "手机号还是13900005678", "enter");
    assert.equal(first.match(/\[\[PHONE_\d{3}\]\]/)?.[0], "[[PHONE_001]]");
    assert.equal(second.match(/\[\[PHONE_\d{3}\]\]/)?.[0], "[[PHONE_001]]");
    await page.close();
  });

  it("普通讨论不含敏感信息时保留原文", async (test) => {
    const page = await openComposer(test);
    const text = "今天只讨论接口设计，先整理需求，再安排测试。";
    assert.equal(await submit(page, text), text);
    const status = await popup.evaluate(async () => chrome.runtime.sendMessage({ type: "NEURAL_REVIEW_STATUS" }));
    assert.equal(status.ready, true, "The real offscreen model must have executed, not an empty mocked provider");
    await page.close();
  });

  it("页面取消神经复核重放后不复用旧发送授权", async (test) => {
    const page = await openComposer(test);
    await page.getByRole("textbox").fill("手机号：13800138000");
    await page.evaluate(() => {
      window.cancelledSyntheticClicks = 0;
      window.addEventListener("click", (event) => {
        if (!event.isTrusted && window.cancelledSyntheticClicks === 0) {
          window.cancelledSyntheticClicks += 1;
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
    });

    await page.getByRole("button", { name: "发送", exact: true }).click();
    const cancelled = await waitFor(async () => page.evaluate(() =>
      window.cancelledSyntheticClicks > 0 ? window.cancelledSyntheticClicks : null,
    ));
    assert.equal(cancelled, 1, "the page must cancel the extension's first synthetic replay");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const laterEvents = await page.evaluate(() => {
      const editor = document.querySelector("#prompt-textarea");
      const form = editor?.closest("form");
      const button = document.querySelector("#composer-submit-button");
      if (!editor || !form || !button) {
        throw new Error("The controlled composer disappeared before the later-event check");
      }
      const clickDispatched = button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const submitDispatched = form.dispatchEvent(new SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
        submitter: button,
      }));
      return {
        clickPrevented: !clickDispatched,
        submitPrevented: !submitDispatched,
        submissions: window.submissions.length,
      };
    });

    assert.equal(laterEvents.clickPrevented, true);
    assert.equal(laterEvents.submitPrevented, true);
    assert.equal(laterEvents.submissions, 0);
  });
});
