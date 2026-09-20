// ml/docs/r3-model-card.md 从 R3 起立着的发布门槛，在真实 Chrome 里执行。
//
// 四件 Node 与 jsdom 都测不到的事，而它们是"代码是对的"与"装上之后能用"之间的全部差别：
//
//   1. 真实浏览器能否创建 offscreen 文档。`chrome.offscreen.createDocument` 在真实 MV3 service
//      worker 之外不存在，所以现有测试全都打了桩。
//   2. ONNX Runtime 的 WASM 能否在 `script-src 'self' 'wasm-unsafe-eval'` 下加载并实例化。
//      `tests/manifest.test.ts` 只断言了这个 CSP **字符串**存在。**而且 CSP 拒绝是静默的**：
//      离屏文档记下 ready: false，扩展退化成纯规则，用户看不到任何报错。
//   3. 跨过两跳 chrome.runtime 之后的跨度是否与离线评测一致（结构化克隆、UTF-16 偏移、消息校验器）。
//   4. 冷启动与内存在浏览器里到底多少。
//
// 预期跨度不是手写的：同一次运行里由 Node ONNX 路径算出，而那条路径由 parity 夹具钉住与 Python 参考
// 一致。所以换出货产物后这个测试仍然成立，且只隔离一个变量——浏览器。
//
// 装载方式见 launch-extension.mjs 顶部，那里记着所有试过并失败的路径。
//
// 跑法：npm run test:browser
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import { harnessBundle } from "../../scripts/harness-paths.mjs";
import {
  launchWithExtension,
  repositoryRoot,
  resolveBrowserTestDist,
  waitFor,
} from "./launch-extension.mjs";

// 每条草稿针对门槛关心的一项性质。短是有意的：失败时要能一眼看出是哪一类。
const DRAFTS = [
  "周妍舒昨天说过这件事",
  "武汉市洪山区霁虹街95号",
  "🙂 请联系张默言确认交付时间",
  "请搜索 wxid_demo_123 看看",
  "今天的天气很好，适合出门。",
];

let context;
let extensionId;
let browserVersion;
let close = async () => {};
const consoleErrors = [];

async function referenceHints() {
  // 与离线评测同一个入口，所以这是被评测过的那条代码路径，不是它的另一份实现。
  const bundlePath = await harnessBundle("browser-reference.mjs");
  await build({
    entryPoints: [resolve(repositoryRoot, "tests", "probe", "neural-detector-entry.ts")],
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["node20"],
    legalComments: "none",
  });
  await import(pathToFileURL(bundlePath).href);
  const detector = globalThis.__neuralDetector;

  const modelDirectory = resolve(repositoryRoot, "src", "assets", "model");
  const manifest = JSON.parse(await readFile(resolve(modelDirectory, "runtime_manifest.json"), "utf8"));
  await detector.load({
    model: new Uint8Array(await readFile(resolve(modelDirectory, "model.int8.onnx"))),
    wasmDirectoryUrl: `${pathToFileURL(resolve(repositoryRoot, "node_modules", "onnxruntime-web", "dist")).href}/`,
    vocabulary: JSON.parse(await readFile(resolve(modelDirectory, "vocab.json"), "utf8")),
    labels: Object.entries(manifest.labels)
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, label]) => label),
    threshold: manifest.threshold,
    maxLength: manifest.max_length,
    stride: manifest.stride,
    loadOrt: () => import("onnxruntime-web/wasm"),
  });

  const byDraft = {};
  for (const draft of DRAFTS) {
    await detector.prime(draft);
    // 比 hints 而不是 detector 跨度：hints 才是跨两跳 chrome.runtime 的东西，不一致时能定位到浏览器栈。
    byDraft[draft] = detector.hints(draft).map((hint) => `${hint.kind}:${hint.start}:${hint.end}`);
  }
  await rm(bundlePath, { force: true });
  return { byDraft, artifact: manifest.artifact };
}

async function reviewInBrowser(page, text) {
  return page.evaluate(async (draft) => {
    const started = performance.now();
    const response = await chrome.runtime.sendMessage({
      type: "NEURAL_REVIEW_REQUEST",
      requestId: `browser-test-${Math.random().toString(36).slice(2)}`,
      text: draft,
    });
    return { response, elapsedMs: performance.now() - started };
  }, text);
}

describe("本地模型在真实 Chrome 里", () => {
  before(async () => {
    const launched = await launchWithExtension({
      port: 9222,
      distDirectory: resolveBrowserTestDist(),
    });
    context = launched.context;
    extensionId = launched.extensionId;
    browserVersion = launched.browserVersion;
    close = launched.close;
    // CSP 拒绝与 WASM 实例化失败都只会出现在这里，不会抛出来，所以要收集而不是只在末尾断言。
    context.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    context.on("weberror", (error) => consoleErrors.push(String(error.error())));
  });

  after(async () => {
    await close();
  });

  it("装载成功且扩展页可用", async () => {
    assert.match(extensionId, /^[a-p]{32}$/, `扩展 id 形状不对：${extensionId}`);
    const page = await context.newPage();
    const response = await page.goto(`chrome-extension://${extensionId}/popup.html`);
    assert.equal(response?.status(), 200);
    const runtime = await page.evaluate(() => ({
      id: chrome?.runtime?.id ?? null,
      version: chrome?.runtime?.getManifest?.().version ?? null,
    }));
    assert.equal(runtime.id, extensionId);
    assert.ok(runtime.version !== null, "扩展页里拿不到 manifest");
  });

  it("安装时自动打开首次运行页", async () => {
    // 默认档改成了 balanced + local_neural，这一页是那次改动的知情同意配套。它不弹，用户就不知道
    // 本地模型默认开着，也不知道怎么调低。
    const welcome = await waitFor(() =>
      context.pages().find((page) => page.url() === `chrome-extension://${extensionId}/welcome.html`) ?? null,
    );
    assert.ok(welcome !== null, "首次安装没有打开 welcome.html");
    assert.ok(
      (await welcome.textContent("body")).includes("本地神经模型"),
      "首次运行页没有说明默认开启的是哪一档",
    );
  });

  it("创建 offscreen 文档、在扩展页 CSP 下加载 WASM，并与 Node 逐条一致", async () => {
    const { byDraft: expected, artifact } = await referenceHints();

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    // 第一次请求付冷启动：offscreen 创建、manifest 与词表 fetch、ORT 模块 import、WASM 实例化、建会话。
    const coldStarted = Date.now();
    const cold = await reviewInBrowser(page, DRAFTS[0]);
    const coldMilliseconds = Date.now() - coldStarted;
    assert.equal(cold.response?.type, "NEURAL_REVIEW_RESULT");
    assert.equal(
      cold.response?.ok,
      true,
      `模型在浏览器里加载失败：${cold.response?.error}\n控制台错误：\n${consoleErrors.join("\n")}`,
    );

    // 按 id 挑我们自己的 worker。Chrome 自带的组件扩展也有 service worker，取 [0] 会问错扩展
    // 有没有 offscreen 文档，而那当然是 false。
    const worker = await waitFor(
      () =>
        context
          .serviceWorkers()
          .find((candidate) => candidate.url().startsWith(`chrome-extension://${extensionId}/`)) ?? null,
    );
    assert.ok(worker !== null, "处理过消息之后本扩展的 service worker 仍未出现");
    const offscreenExists = await worker.evaluate(async () => chrome.offscreen.hasDocument());
    assert.equal(offscreenExists, true, "offscreen 文档没有被创建");

    const measured = {};
    const timings = [];
    for (const [index, draft] of DRAFTS.entries()) {
      const result = index === 0 ? cold : await reviewInBrowser(page, draft);
      assert.equal(result.response?.ok, true, `${draft} 复核失败：${result.response?.error}`);
      measured[draft] = result.response.hints.map((hint) => `${hint.kind}:${hint.start}:${hint.end}`);
      timings.push({ chars: draft.length, ms: Number(result.elapsedMs.toFixed(1)) });
    }
    for (const draft of DRAFTS) {
      assert.deepEqual(measured[draft], expected[draft], `浏览器与 Node 在 ${JSON.stringify(draft)} 上不一致`);
    }

    const status = await page.evaluate(async () => chrome.runtime.sendMessage({ type: "NEURAL_REVIEW_STATUS" }));
    assert.equal(status?.ready, true, "offscreen 报告模型未就绪");
    assert.ok(typeof status.loadMilliseconds === "number" && status.loadMilliseconds > 0, "没有报告加载耗时");
    assert.equal(status.error, null, `offscreen 报告了错误：${status.error}`);

    const cspErrors = consoleErrors.filter((text) =>
      /Content Security Policy|wasm|WebAssembly|Refused to/i.test(text),
    );
    assert.deepEqual(cspErrors, [], `真实浏览器里出现 CSP 或 WASM 错误：\n${cspErrors.join("\n")}`);

    // 设置页读 storage.session 而不是发消息（popup.js 被断言不含 sendMessage），所以这里顺带验证
    // 那条发布通道在真实浏览器里确实通了。
    const published = await page.evaluate(async () => {
      const stored = await chrome.storage.session.get("neuralRuntimeStatus");
      return stored.neuralRuntimeStatus ?? null;
    });
    assert.ok(published !== null, "offscreen 没有把运行时状态发布到 storage.session");
    assert.equal(published.ready, true);

    const memory = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
    console.log(
      JSON.stringify(
        {
          browser: browserVersion,
          extensionId,
          artifact,
          coldStartMs: coldMilliseconds,
          modelLoadMs: status.loadMilliseconds,
          requests: timings,
          popupHeapMB: memory === null ? null : Number((memory / 1048576).toFixed(1)),
          consoleErrors,
        },
        null,
        2,
      ),
    );
  });

  it("空草稿不会报错", async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const result = await reviewInBrowser(page, "");
    assert.equal(result.response?.type, "NEURAL_REVIEW_RESULT");
    if (result.response.ok === true) {
      assert.deepEqual(result.response.hints, []);
    }
  });
});
