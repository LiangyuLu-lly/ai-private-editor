import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { getRegisteredSiteAdapters } from "../src/sites/registry.js";

type ExtensionManifest = {
  manifest_version: number;
  minimum_chrome_version?: string;
  permissions?: string[];
  host_permissions?: string[];
  icons?: Record<string, string>;
  action?: {
    default_title?: string;
    default_popup?: string;
    default_icon?: Record<string, string>;
  };
  side_panel?: { default_path?: string };
  background?: unknown;
  content_security_policy?: {
    extension_pages?: string;
  };
  content_scripts?: Array<{
    matches?: string[];
    run_at?: string;
    js?: string[];
    css?: string[];
  }>;
};

function loadManifest(): ExtensionManifest {
  const manifestPath = resolve(process.cwd(), "src", "manifest.json");
  return JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;
}

describe("extension manifest", () => {
  it("registers only the document-start content script for the supported chat sites", () => {
    const manifest = loadManifest();

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe("116");
    // `offscreen` is required to host the local student model. It grants no access to page
    // content or the network — it only lets the extension open its own invisible page, which is
    // where WASM inference runs so that draft text never leaves the device.
    expect(manifest.permissions).toEqual(["storage", "sidePanel", "offscreen"]);
    const iconSet = {
      16: "assets/icons/icon-16.png",
      32: "assets/icons/icon-32.png",
      48: "assets/icons/icon-48.png",
      128: "assets/icons/icon-128.png",
    };
    expect(manifest.action).toEqual({
      default_title: "管理自定义敏感词",
      default_popup: "popup.html",
      default_icon: iconSet,
    });
    expect(manifest.icons).toEqual(iconSet);
    expect(manifest.host_permissions).toEqual([
      "https://www.doubao.com/*",
      "https://doubao.com/*",
      "https://chat.deepseek.com/*",
      "https://yuanbao.tencent.com/*",
      "https://chatgpt.com/*",
      "https://claude.ai/*",
      "https://gemini.google.com/*",
      "https://www.kimi.com/*",
      "https://www.qianwen.com/*",
      "https://yiyan.baidu.com/*",
      "https://wenxin.baidu.com/*",
    ]);
    expect(manifest.side_panel).toEqual({ default_path: "sidepanel.html" });
    expect(manifest.background).toEqual({ service_worker: "background.js" });
    expect(manifest.content_security_policy).toEqual({
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    });
    expect(manifest.content_scripts).toEqual([
      expect.objectContaining({
        matches: [
          "https://www.doubao.com/*",
          "https://doubao.com/*",
          "https://chat.deepseek.com/*",
          "https://yuanbao.tencent.com/*",
          "https://chatgpt.com/*",
          "https://claude.ai/*",
          "https://gemini.google.com/*",
          "https://www.kimi.com/*",
          "https://www.qianwen.com/*",
          "https://yiyan.baidu.com/*",
          "https://wenxin.baidu.com/*",
        ],
        run_at: "document_start",
        js: ["content.js"],
        css: ["content.css"],
      }),
    ]);

    const allPermissions = [
      ...(manifest.permissions ?? []),
      ...(manifest.host_permissions ?? []),
    ];

    for (const forbidden of [
      "tabs",
      "webRequest",
      "declarativeNetRequest",
      "<all_urls>",
    ]) {
      expect(allPermissions).not.toContain(forbidden);
    }
  });

  it("keeps the registered adapter patterns, host permissions, and injection scope identical", () => {
    const manifest = loadManifest();
    const adapterPatterns = getRegisteredSiteAdapters().flatMap((adapter) => adapter.matchPatterns);
    const contentScriptPatterns = manifest.content_scripts?.flatMap((script) => script.matches ?? []);

    expect(adapterPatterns).toEqual(manifest.host_permissions);
    expect(contentScriptPatterns).toEqual(manifest.host_permissions);
  });

  it("ships privacy documentation with the local-processing limitation", () => {
    const readDocument = (filename: string) => readFileSync(resolve(process.cwd(), filename), "utf8");

    expect(readDocument("README.md")).toContain("发送前");
    expect(readDocument("README.md")).toContain("未命中");
    expect(readDocument("README.md")).toContain("自定义敏感词");
    expect(readDocument("README.md")).toContain("仅保存在此浏览器本地");
    expect(readDocument("README.md")).toContain("词库正在加载");
    expect(readDocument("README.md")).toContain("严格模式");
    expect(readDocument("README.md")).toContain("适配健康检查失败");
    expect(readDocument("README.md")).toContain("yuanbao.tencent.com");
    expect(readDocument("README.md")).toContain("元宝 Beta");
    expect(readDocument("README.md")).toContain("ChatGPT");
    expect(readDocument("README.md")).toContain("Claude");
    expect(readDocument("README.md")).toContain("粘贴前");
    expect(readDocument("README.md")).toContain("类别策略");
    expect(readDocument("README.md")).toContain("本地审计");
    expect(readDocument("README.md")).toContain("配置迁移");
    expect(readDocument("README.md")).toContain("Kimi");
    expect(readDocument("README.md")).toContain("通义");
    expect(readDocument("README.md")).toContain("文心");
    expect(readDocument("README.md")).toContain("本地文件扫描");
    expect(readDocument("README.md")).toContain("不能保证阻止网站已经发起的上传");
    expect(readDocument("README.md")).toContain("本地统计模型");
    expect(readDocument("README.md")).toContain("需复核");
    expect(readDocument("README.md")).toContain("双向格式控制字符");
    expect(readDocument("PRIVACY.md")).toContain("chrome.storage.local");
    expect(readDocument("PRIVACY.md")).toContain("不进行 Chrome 同步");
    expect(readDocument("PRIVACY.md")).toContain("网页 DOM");
    expect(readDocument("PRIVACY.md")).toContain("不拦截");
    expect(readDocument("PRIVACY.md")).toContain("严格模式");
    expect(readDocument("PRIVACY.md")).toContain("适配健康检查失败");
    expect(readDocument("PRIVACY.md")).toContain("yuanbao.tencent.com");
    expect(readDocument("PRIVACY.md")).toContain("认证后的真实发送链路尚未");
    expect(readDocument("PRIVACY.md")).toContain("ChatGPT");
    expect(readDocument("PRIVACY.md")).toContain("Claude");
    expect(readDocument("PRIVACY.md")).toContain("本地审计");
    expect(readDocument("PRIVACY.md")).toContain("配置导出");
    expect(readDocument("PRIVACY.md")).toContain("回复令牌查看");
    expect(readDocument("PRIVACY.md")).toContain("附件内容");
    expect(readDocument("PRIVACY.md")).toContain("OCR 文本");
    expect(readDocument("PRIVACY.md")).toContain("不能保证阻止网站已经发起的上传");
    expect(readDocument("PRIVACY.md")).toContain("需复核");
    expect(readDocument("THIRD_PARTY_NOTICES.md")).toContain("Tesseract.js");
    expect(readDocument("PRIVACY.md")).not.toContain("不使用 `chrome.storage`");
    expect(readDocument("PRIVACY.md")).toContain("草稿在侧栏内存中检查");
  });
});
