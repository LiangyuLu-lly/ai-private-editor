// 在真实 Chrome 里装载本扩展的唯一可行方式（本机 Chrome 152 上实测）。
//
// 关键在于**不要让 Playwright 自己 spawn 浏览器**。以下都试过并失败：
//
//   --load-extension                              被忽略。加 --disable-features=DisableLoadExtensionCommandLineSwitch
//                                                 或 --enable-unsafe-extension-debugging 也一样，/json/list 里只有
//                                                 Chrome 自带的组件扩展。Chrome 137 起收紧了这个开关。
//   launchPersistentContext + loadUnpacked        返回 id，但扩展不可达：chrome://extensions 列表为空、
//                                                 扩展页 ERR_BLOCKED_BY_CLIENT、内容脚本不注入、无 SW target。
//   Target.createTarget({newWindow:true})         新窗口里导航到扩展页仍失败（chrome-error://chromewebdata）。
//   两阶段：装进持久化 profile 后重启               同样 ERR_BLOCKED_BY_CLIENT。
//   Edge                                          Node spawn 层就 EACCES（PowerShell 里直接运行正常，ACL 也允许）。
//
// 可行的组合是：自己 spawn chrome.exe，完全控制命令行，带 --remote-debugging-port 与
// --enable-unsafe-extension-debugging，然后 connectOverCDP 连上去，再用 CDP Extensions.loadUnpacked 装载。
// 这样扩展在 chrome://extensions 里是 enabled、扩展页返回 200、chrome.runtime 可用、service worker 与
// offscreen 都能起来。
//
// 抽成模块是因为浏览器回归与商店截图脚本都要用它，而这套顺序里任何一步换掉都会退回上面某一种失败。
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(here, "..", "..");

export function resolveBrowserTestDist(environment = process.env, root = repositoryRoot) {
  const requested = environment.PRIVATE_COMPOSER_TEST_DIST;
  return typeof requested === "string" && requested.trim().length > 0
    ? resolve(root, requested)
    : resolve(root, "dist");
}

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];

async function findChrome() {
  const { access } = await import("node:fs/promises");
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

async function waitForEndpoint(port, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  return null;
}

/**
 * 启动 Chrome、装载 dist/、返回可用的上下文与扩展 id。
 *
 * `port` 可传，避免并行运行的两个脚本抢同一个调试端口。
 */
export async function launchWithExtension({ port = 9222, distDirectory = resolveBrowserTestDist() } = {}) {
  const executable = await findChrome();
  if (executable === null) {
    throw new Error(`未找到 Chrome，试过：${CHROME_CANDIDATES.join(", ")}`);
  }
  const profile = await mkdtemp(resolve(tmpdir(), "privacy-ext-"));
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      // CDP Extensions.loadUnpacked 需要它。
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  const version = await waitForEndpoint(port, 40);
  if (version === null) {
    throw new Error(`Chrome 的调试端口 ${port} 没有起来`);
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const session = await browser.newBrowserCDPSession();
  // 这一步会在 dist 含 `_` 前缀文件名时报错——Chrome 拒绝加载整个扩展目录。
  // 那正是它第一次跑时暴露的缺陷，现在由 scripts/harness-paths.mjs 与打包检查兜住。
  const { id } = await session.send("Extensions.loadUnpacked", { path: distDirectory });

  const close = async () => {
    await browser.close().catch(() => {});
    try {
      process.kill(-child.pid);
    } catch {
      try {
        process.kill(child.pid);
      } catch {
        // 已退出
      }
    }
    await new Promise((done) => setTimeout(done, 800));
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };

  return { browser, context, extensionId: id, browserVersion: version.Browser, close };
}

/** 等到某个条件成立，或超时返回 null。轮询而不是 waitForEvent：MV3 的 worker 是懒启动的。 */
export async function waitFor(probe, { attempts = 40, intervalMilliseconds = 250 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) {
      return value;
    }
    await new Promise((done) => setTimeout(done, intervalMilliseconds));
  }
  return null;
}
