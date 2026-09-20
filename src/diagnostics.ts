/*
 * Built-in self-check for the local semantic model.
 *
 * Why this exists rather than an automated browser test: on the development machine no automation
 * route into a real browser works. Chrome 152 ignores `--load-extension` (with and without
 * `--disable-features=DisableLoadExtensionCommandLineSwitch` and
 * `--enable-unsafe-extension-debugging`); CDP `Extensions.loadUnpacked` returns an id but the
 * extension stays unreachable — chrome://extensions lists nothing, its pages answer
 * ERR_BLOCKED_BY_CLIENT, content scripts never inject, no service-worker target appears; and Edge
 * cannot be spawned from Node at all (EACCES, though it runs fine from a shell).
 *
 * `ml/docs/r3-model-card.md` set a release gate that has been unmet since R3: offscreen creation,
 * WASM under the extension-page CSP, cold start and memory, all in a real browser. Automation cannot
 * close it here, so this page lets a person close it in about a minute and keep the evidence.
 *
 * Four things it establishes, none of which any Node or jsdom test can:
 *   1. `chrome.offscreen.createDocument` succeeds in this browser.
 *   2. ONNX Runtime's WASM loads and instantiates under `script-src 'self' 'wasm-unsafe-eval'`.
 *      A CSP refusal leaves the offscreen host at `ready: false`; the R9 send-time gate then
 *      surfaces the unavailable review and requires cancellation or an explicit one-time raw send.
 *   3. Spans that survive two `chrome.runtime` hops match the offline evaluation exactly.
 *   4. What cold start and per-draft latency actually cost on this hardware.
 *
 * The expected spans are generated from the shipped artifact by
 * `scripts/emit-selfcheck-expectations.mjs`, not written by hand. Hand-written expectations would
 * make a passing self-check meaningless.
 */

import {
  NEURAL_REVIEW_REQUEST,
  NEURAL_REVIEW_STATUS,
  isNeuralReviewResult,
  isNeuralReviewStatus,
} from "./shared/neural/messages.js";

type SelfCheckCase = {
  id: string;
  text: string;
  note: string;
  expected: readonly { kind: string; start: number; end: number }[];
};

// artifact: r9-electra-chat-augmented/checkpoint-3798, threshold 0.15
// regenerate with: node scripts/emit-selfcheck-expectations.mjs
const SELF_CHECK_CASES: readonly SelfCheckCase[] = [
  {
    id: "bare-person",
    text: "周妍舒昨天说过这件事",
    note: "裸人名，规则接不住，这一条证明模型真的在跑",
    expected: [{ kind: "person_name", start: 0, end: 3 }],
  },
  {
    id: "unanchored-address",
    text: "武汉市洪山区霁虹街95号",
    note: "无锚词地址",
    expected: [{ kind: "address", start: 0, end: 12 }],
  },
  {
    id: "anchored-person",
    text: "客户张伟会尽快跟进。",
    note: "有锚词的人名",
    expected: [{ kind: "person_name", start: 2, end: 4 }],
  },
  {
    id: "account-alias",
    text: "请搜索 wxid_demo_123 看看",
    note: "账号别名经过本地形态和上下文门控",
    expected: [{ kind: "account", start: 4, end: 17 }],
  },
  {
    id: "organisation",
    text: "请联系华为处理云服务故障。",
    note: "机构名不该被当成人名",
    expected: [],
  },
  {
    id: "clean",
    text: "今天天气很好，适合出去走走。",
    note: "干净文本，必须没有任何提示",
    expected: [],
  },
  {
    id: "obfuscated",
    text: "客户张\u200b默\u2066言会跟进。",
    note: "零宽与双向控制符混淆，考归一化视图与偏移回映",
    expected: [{ kind: "person_name", start: 2, end: 7 }],
  },
];

const runButton = document.querySelector<HTMLButtonElement>("#run-selfcheck");
const statusLine = document.querySelector<HTMLParagraphElement>("#selfcheck-status");
const environmentList = document.querySelector<HTMLDListElement>("#environment");
const casesBody = document.querySelector<HTMLTableSectionElement>("#cases-body");
const reportArea = document.querySelector<HTMLTextAreaElement>("#report");
const copyButton = document.querySelector<HTMLButtonElement>("#copy-report");

function describeSpans(spans: readonly { kind: string; start: number; end: number }[]): string {
  return spans.length === 0 ? "（无）" : spans.map((span) => `${span.kind} ${span.start}–${span.end}`).join("；");
}

/** Render printable escapes so a zero-width character is visible in the table. */
function visible(text: string): string {
  return text.replace(/[\u200b-\u200f\u2060-\u2064\u2066-\u206f\ufeff]/gu, (character) =>
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, "0")}`,
  );
}

function setRows(rows: readonly HTMLTableRowElement[]): void {
  if (casesBody === null) {
    return;
  }
  casesBody.replaceChildren(...rows);
}

function cell(text: string, className?: string): HTMLTableCellElement {
  const element = document.createElement("td");
  element.textContent = text;
  if (className !== undefined) {
    element.className = className;
  }
  return element;
}

type CaseOutcome = {
  id: string;
  passed: boolean;
  expected: string;
  actual: string;
  elapsedMs: number | null;
  error: string | null;
};

async function requestReview(text: string): Promise<{ hints: unknown[]; error: string | null }> {
  const requestId = `selfcheck-${crypto.randomUUID()}`;
  const reply: unknown = await chrome.runtime.sendMessage({
    type: NEURAL_REVIEW_REQUEST,
    requestId,
    text,
  });
  if (!isNeuralReviewResult(reply, text, requestId)) {
    // Deliberately treated as a failure rather than an empty result: an unrecognised shape here
    // means the boundary contract changed, and silently reporting "no hints" would look like a pass.
    return { hints: [], error: "回复不符合协议（isNeuralReviewResult 校验未通过）" };
  }
  return reply.ok ? { hints: reply.hints, error: null } : { hints: [], error: reply.error };
}

async function readStatus(): Promise<{ ready: boolean; loadMilliseconds: number | null; error: string | null }> {
  const reply: unknown = await chrome.runtime.sendMessage({ type: NEURAL_REVIEW_STATUS });
  return isNeuralReviewStatus(reply)
    ? { ready: reply.ready, loadMilliseconds: reply.loadMilliseconds, error: reply.error }
    : { ready: false, loadMilliseconds: null, error: "状态回复不符合协议" };
}

async function readManifest(): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(chrome.runtime.getURL("assets/model/runtime_manifest.json"));
    return response.ok ? ((await response.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function renderEnvironment(entries: readonly [string, string][]): void {
  if (environmentList === null) {
    return;
  }
  const nodes: HTMLElement[] = [];
  for (const [key, value] of entries) {
    const term = document.createElement("dt");
    term.textContent = key;
    const detail = document.createElement("dd");
    detail.textContent = value;
    nodes.push(term, detail);
  }
  environmentList.replaceChildren(...nodes);
}

async function run(): Promise<void> {
  if (runButton === null || statusLine === null) {
    return;
  }
  runButton.disabled = true;
  statusLine.textContent = "正在加载模型并逐条比对…";

  const manifest = await readManifest();
  const outcomes: CaseOutcome[] = [];
  const rows: HTMLTableRowElement[] = [];

  // First request pays the cold start: offscreen creation, manifest and vocabulary fetch, ORT module
  // import, WASM instantiation, session creation. Measured separately from the warm ones because it
  // is the number the release gate asks for.
  const coldStarted = performance.now();
  const firstCase = SELF_CHECK_CASES[0];
  const first = firstCase === undefined ? null : await requestReview(firstCase.text);
  const coldMilliseconds = performance.now() - coldStarted;

  for (const [index, testCase] of SELF_CHECK_CASES.entries()) {
    const started = performance.now();
    const result = index === 0 && first !== null ? first : await requestReview(testCase.text);
    const elapsed = index === 0 ? coldMilliseconds : performance.now() - started;

    const actualSpans = (result.hints as { kind: string; start: number; end: number }[]).map(
      ({ kind, start, end }) => ({ kind, start, end }),
    );
    const expected = describeSpans(testCase.expected);
    const actual = describeSpans(actualSpans);
    const passed = result.error === null && expected === actual;
    outcomes.push({
      id: testCase.id,
      passed,
      expected,
      actual: result.error === null ? actual : `错误：${result.error}`,
      elapsedMs: Math.round(elapsed),
      error: result.error,
    });

    const row = document.createElement("tr");
    row.append(
      cell(passed ? "通过" : "不通过", passed ? "verdict pass" : "verdict fail"),
      cell(visible(testCase.text), "draft"),
      cell(testCase.note, "note"),
      cell(expected, "spans"),
      cell(result.error === null ? actual : `错误：${result.error}`, "spans"),
      cell(`${Math.round(elapsed)} ms`, "timing"),
    );
    rows.push(row);
    setRows(rows);
  }

  const status = await readStatus();
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const passedCount = outcomes.filter((outcome) => outcome.passed).length;
  const warm = outcomes.slice(1).map((outcome) => outcome.elapsedMs ?? 0);
  const warmAverage = warm.length === 0 ? 0 : Math.round(warm.reduce((sum, value) => sum + value, 0) / warm.length);

  renderEnvironment([
    ["扩展版本", chrome.runtime.getManifest().version],
    ["构建标识", chrome.runtime.getManifest().version_name ?? "未声明"],
    ["浏览器", navigator.userAgent],
    ["逻辑核心数", String(navigator.hardwareConcurrency ?? "未知")],
    ["模型产物", String(manifest?.artifact ?? "读取失败")],
    ["阈值 / 窗口 / 步长", `${String(manifest?.threshold)} / ${String(manifest?.max_length)} / ${String(manifest?.stride)}`],
    ["offscreen 文档就绪", status.ready ? "是" : "否"],
    ["模型加载耗时", status.loadMilliseconds === null ? "未报告" : `${status.loadMilliseconds} ms`],
    ["offscreen 报告的错误", status.error ?? "无"],
    ["首次请求（含冷启动）", `${Math.round(coldMilliseconds)} ms`],
    ["其余请求平均", `${warmAverage} ms`],
    ["此页 JS 堆占用", memory === undefined ? "浏览器未提供" : `${(memory.usedJSHeapSize / 1048576).toFixed(1)} MB`],
  ]);

  const allPassed = passedCount === outcomes.length && status.ready && status.error === null;
  statusLine.textContent = allPassed
    ? `全部通过：${passedCount}/${outcomes.length} 条与离线评测一致，模型在这个浏览器里正常工作。`
    : `${passedCount}/${outcomes.length} 条通过。${status.ready ? "" : "模型未就绪，发送时会要求取消或确认一次原文发送。"}`;
  statusLine.className = allPassed ? "run-status ok" : "run-status bad";

  if (reportArea !== null) {
    reportArea.value = [
      "AI 私密编辑 — 本地模型自检报告",
      `时间：${new Date().toISOString()}`,
      `扩展版本：${chrome.runtime.getManifest().version} (${chrome.runtime.getManifest().version_name ?? "无构建标识"})`,
      `浏览器：${navigator.userAgent}`,
      `模型产物：${String(manifest?.artifact ?? "读取失败")}，阈值 ${String(manifest?.threshold)}`,
      `offscreen 就绪：${status.ready ? "是" : "否"}，加载耗时 ${status.loadMilliseconds ?? "未报告"} ms，错误 ${status.error ?? "无"}`,
      `冷启动 ${Math.round(coldMilliseconds)} ms，其余请求平均 ${warmAverage} ms`,
      `此页 JS 堆占用：${memory === undefined ? "浏览器未提供" : `${(memory.usedJSHeapSize / 1048576).toFixed(1)} MB`}`,
      `逐条比对：${passedCount}/${outcomes.length} 通过`,
      ...outcomes.map(
        (outcome) =>
          `  [${outcome.passed ? "通过" : "不通过"}] ${outcome.id}  预期 ${outcome.expected}  实测 ${outcome.actual}  ${outcome.elapsedMs} ms`,
      ),
      allPassed
        ? "结论：offscreen 文档创建成功、WASM 在扩展页 CSP 下加载成功、推理结果与离线评测一致。"
        : "结论：存在不一致或模型未就绪，详见上面各行。",
    ].join("\n");
  }

  runButton.disabled = false;
}

runButton?.addEventListener("click", () => {
  void run().catch((error: unknown) => {
    if (statusLine !== null) {
      statusLine.textContent = `自检本身出错：${error instanceof Error ? error.message : String(error)}`;
      statusLine.className = "run-status bad";
    }
    if (runButton !== null) {
      runButton.disabled = false;
    }
  });
});

copyButton?.addEventListener("click", () => {
  if (reportArea === null || reportArea.value.length === 0) {
    return;
  }
  void navigator.clipboard.writeText(reportArea.value).then(
    () => {
      copyButton.textContent = "已复制";
      window.setTimeout(() => {
        copyButton.textContent = "复制报告";
      }, 1500);
    },
    () => {
      // Clipboard permission can be refused; selecting the text is the fallback that always works.
      reportArea.select();
      copyButton.textContent = "已选中，请按 Ctrl+C";
    },
  );
});

// Show the static half of the environment before anything is run, so the page is useful even if the
// model fails to load.
void (async () => {
  const manifest = await readManifest();
  renderEnvironment([
    ["扩展版本", chrome.runtime.getManifest().version],
    ["构建标识", chrome.runtime.getManifest().version_name ?? "未声明"],
    ["浏览器", navigator.userAgent],
    ["模型产物", String(manifest?.artifact ?? "读取失败（模型可能未打包）")],
    ["阈值 / 窗口 / 步长", `${String(manifest?.threshold)} / ${String(manifest?.max_length)} / ${String(manifest?.stride)}`],
  ]);
})();
