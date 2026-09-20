/*
 * 本地模型的运行时状态，经 `chrome.storage.session` 发布。
 *
 * 为什么不是消息：`tests/build.test.ts` 断言打包后的 `popup.js` 不含 `sendMessage`，与 `scanner.js`
 * 成对。那是一条隐私属性——设置页与扫描页是纯本地 UI，不与页面或 service worker 通信——不该为了
 * 显示一行状态就放宽。
 *
 * 为什么需要发布状态："已启用"和"真的在工作"是两种状态，而两者之间的差别原本是不可见的：如果扩展页
 * CSP 拒了 WASM、或者产物没打进包，offscreen 文档记下 `ready: false`，提示缓存保持空；发送时的
 * R9 门禁会要求用户取消，或明确确认一次原文发送。界面必须把这条边界说清楚，不能伪装成规则已覆盖。
 *
 * 用 `storage.session` 而不是 `storage.local`：这是运行时状态，浏览器重启后应当消失，不该落盘。
 * 里面不含任何草稿内容，只有就绪与否、加载耗时、错误信息。
 */

export const NEURAL_RUNTIME_STATUS_KEY = "neuralRuntimeStatus";

export type NeuralRuntimeStatus = {
  ready: boolean;
  loadMilliseconds: number | null;
  error: string | null;
  /** 写入时刻，用于判断这份状态是否来自本次浏览器会话。 */
  updatedAt: number;
};

export function isNeuralRuntimeStatus(value: unknown): value is NeuralRuntimeStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  return (
    keys.length === 4 &&
    keys.every((key) => ["ready", "loadMilliseconds", "error", "updatedAt"].includes(key)) &&
    typeof candidate.ready === "boolean" &&
    (candidate.loadMilliseconds === null || typeof candidate.loadMilliseconds === "number") &&
    (candidate.error === null || typeof candidate.error === "string") &&
    typeof candidate.updatedAt === "number" &&
    Number.isFinite(candidate.updatedAt)
  );
}

type SessionArea = {
  set(items: Record<string, unknown>): Promise<void>;
  get(keys: string | string[]): Promise<Record<string, unknown>>;
};

function sessionArea(): SessionArea | null {
  // `storage.session` needs Chrome 102 and the `storage` permission. Absent in tests and in older
  // builds, so every caller treats a missing area as "no status available" rather than an error.
  const area = (globalThis as { chrome?: { storage?: { session?: SessionArea } } }).chrome?.storage?.session;
  return area ?? null;
}

/** Publish the current state. Failures are swallowed: status reporting must never break inference. */
export async function publishNeuralRuntimeStatus(
  status: Omit<NeuralRuntimeStatus, "updatedAt">,
): Promise<void> {
  const area = sessionArea();
  if (area === null) {
    return;
  }
  try {
    await area.set({ [NEURAL_RUNTIME_STATUS_KEY]: { ...status, updatedAt: Date.now() } });
  } catch {
    // Ignored on purpose.
  }
}

/** Read the published state, or null when nothing has been published in this browser session. */
export async function readNeuralRuntimeStatus(): Promise<NeuralRuntimeStatus | null> {
  const area = sessionArea();
  if (area === null) {
    return null;
  }
  try {
    const stored = await area.get(NEURAL_RUNTIME_STATUS_KEY);
    const value = stored[NEURAL_RUNTIME_STATUS_KEY];
    return isNeuralRuntimeStatus(value) ? value : null;
  } catch {
    return null;
  }
}
