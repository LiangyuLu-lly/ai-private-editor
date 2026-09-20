import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("extension build", () => {
  it("keeps user-facing safety boundaries aligned with the runtime", () => {
    const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
    const privacy = readFileSync(resolve(process.cwd(), "PRIVACY.md"), "utf8");

    expect(readme).toContain("确认类命中默认先提供“匿名化发送”");
    expect(readme).toContain("原文发送仅适用于本次");
    expect(readme).toContain("全局白名单静默放行");
    expect(readme).toContain("敏感文本可能按原文发送");
    expect(privacy).toContain("确认类命中默认先提供“匿名化发送”");
    expect(privacy).toContain("未验证附件节点不提供扫描保证");
    expect(privacy).toContain("用户直接输入网页聊天框的原文存在于目标页面 DOM");
    expect(privacy).toContain("超长凭证只保留不可逆的短标记");
    expect(privacy).toContain("默认仅包含自定义词、类别策略、保护设置和审计开关");
    expect(readme).toContain("等待同一份最终草稿完成本地复核");
    expect(privacy).toContain("发送时会停止原始事件并对最终草稿执行一次精确复核");
  });

  it("keeps the shipped model registry, artifact and runtime manifest in one release", () => {
    expect(() => {
      execFileSync(process.execPath, ["scripts/verify-release-consistency.mjs"], {
        cwd: process.cwd(),
        stdio: "pipe",
      });
    }).not.toThrow();
  });

  it("publishes only the verified extension bundle and privacy documents", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      files?: string[];
      scripts?: Record<string, string>;
    };

    expect(packageJson.files).toEqual(["dist", "README.md", "PRIVACY.md", "THIRD_PARTY_NOTICES.md"]);
    expect(packageJson.scripts?.package).toContain("package-extension.mjs");

    const dryRun = JSON.parse(
      execFileSync(process.execPath, [process.env.npm_execpath ?? resolve(process.cwd(), "node_modules", "npm", "bin", "npm-cli.js"), "pack", "--dry-run", "--json"], {
        cwd: process.cwd(),
        encoding: "utf8",
      }),
    ) as Array<{ files: Array<{ path: string }> }>;
    const packageFiles = dryRun[0]?.files.map((file) => file.path) ?? [];

    expect(packageFiles).toContain("README.md");
    expect(packageFiles).toContain("PRIVACY.md");
    expect(packageFiles).toContain("THIRD_PARTY_NOTICES.md");
    expect(packageFiles.some((file) => file.startsWith("output/") || file.endsWith(".zip"))).toBe(false);
  }, 15_000);

  it("builds exactly the registered extension assets", () => {
    execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: process.cwd() });
    const dist = resolve(process.cwd(), "dist");

    // offscreen.{html,js} host the local student model. They are a separate extension page
    // because the model needs WASM plus a context that is not torn down when idle: the
    // extension's `wasm-unsafe-eval` only covers extension pages, and the service worker is
    // shut down between events.
    expect(readdirSync(dist).sort()).toEqual([
      "assets",
      "background.js",
      "content.css",
      "content.js",
      // diagnostics.{html,css,js}: the built-in self-check. It ships because on machines where a
      // real browser cannot be automated it is the only way to close the release gate — offscreen
      // creation, WASM under the extension-page CSP, and span parity with the offline evaluation.
      "diagnostics.css",
      "diagnostics.html",
      "diagnostics.js",
      "manifest.json",
      // welcome.{html,css,js}: opened once on install. It ships because the default settings now
      // enable the local model, and a default that changes behaviour without telling the user is
      // not acceptable. See DEFAULT_ADVANCED_SETTINGS in src/shared/custom-terms.ts.
      "offscreen.html",
      "offscreen.js",
      "popup.css",
      "popup.html",
      "popup.js",
      "scanner.css",
      "scanner.html",
      "scanner.js",
      "sidepanel.css",
      "sidepanel.html",
      "sidepanel.js",
      "vendor",
      "welcome.css",
      "welcome.html",
      "welcome.js",
    ]);
    expect(JSON.parse(readFileSync(resolve(dist, "manifest.json"), "utf8")).action.default_popup).toBe("popup.html");
    const builtManifest = JSON.parse(readFileSync(resolve(dist, "manifest.json"), "utf8")) as { version_name: string };
    expect(JSON.parse(readFileSync(resolve(dist, "manifest.json"), "utf8")).background).toEqual({
      service_worker: "background.js",
    });
    expect(JSON.parse(readFileSync(resolve(dist, "manifest.json"), "utf8")).side_panel).toEqual({
      default_path: "sidepanel.html",
    });
    expect(readFileSync(resolve(dist, "content.js"), "utf8")).toContain(builtManifest.version_name);
    expect(readFileSync(resolve(dist, "content.js"), "utf8")).not.toContain("privacy-hardening-2026-08-27.2");
    expect(readFileSync(resolve(dist, "popup.js"), "utf8")).not.toContain("sendMessage");
    expect(readFileSync(resolve(dist, "background.js"), "utf8")).toContain("outboundText");
    expect(readFileSync(resolve(dist, "sidepanel.js"), "utf8")).toContain("outboundText");
    expect(readdirSync(resolve(dist, "assets", "tessdata")).sort()).toEqual(["chi_sim.traineddata", "eng.traineddata"]);
    expect(readdirSync(resolve(dist, "assets", "presets")).sort()).toEqual([
      "finance.json",
      "legal.json",
      "medical.json",
      "personal.json",
      "rd.json",
      "work.json",
    ]);
    expect(readdirSync(resolve(dist, "assets", "icons")).sort()).toEqual([
      "icon-128.png",
      "icon-16.png",
      "icon-32.png",
      "icon-48.png",
    ]);
    // 商店发布要求图标存在且可解析；这里顺带校验 PNG 签名与声明尺寸。
    for (const size of [16, 32, 48, 128]) {
      const icon = readFileSync(resolve(dist, "assets", "icons", `icon-${size}.png`));
      expect(icon.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(icon.readUInt32BE(16)).toBe(size);
      expect(icon.readUInt32BE(20)).toBe(size);
    }
    expect(readdirSync(resolve(dist, "vendor", "tesseract")).sort()).toEqual([
      "tesseract-core-lstm.wasm",
      "tesseract-core-lstm.wasm.js",
      "worker.min.js",
    ]);
    expect(readdirSync(resolve(dist, "vendor", "pdfjs")).sort()).toEqual(["pdf.worker.mjs"]);
    // ONNX Runtime 需要三个文件，不是两个。`ort-runner.ts` 把 `env.wasm.wasmPaths` 设成目录 URL，
    // 而字符串前缀会让 ORT 把胶水 `ort-wasm-simd-threaded.mjs` 也从那个目录解析，覆盖 bundle 里内联的
    // 那份。少了它，真实浏览器里是：
    //   no available backend found. ERR: [wasm] TypeError: Failed to fetch dynamically imported module
    // 而这个失败对用户是静默的——offscreen 记 ready: false，扩展退回纯规则。也就是说模型对每一个装了
    // 扩展的人都从来没工作过。由 tests/browser/neural-offscreen.test.mjs 在真实 Chrome 里发现。
    expect(readdirSync(resolve(dist, "vendor", "onnxruntime")).sort()).toEqual([
      "ort-wasm-simd-threaded.mjs",
      "ort-wasm-simd-threaded.wasm",
      "ort.wasm.bundle.min.mjs",
    ]);
    expect(readFileSync(resolve(dist, "scanner.js"), "utf8")).not.toContain("sendMessage");
  });

  it("contains no names Chrome reserves, at any depth", () => {
    // Chrome refuses to load an extension directory containing any entry whose name starts with
    // `_`, and the error names only the first offender:
    //
    //   Cannot load extension with file or directory name __neural-eval.mjs.
    //
    // Nine offline harnesses used to write their esbuild bundles into dist/, so whether the built
    // extension was installable depended on what had run last. This asserts the property instead of
    // trusting each harness to clean up. See scripts/harness-paths.mjs.
    const dist = resolve(process.cwd(), "dist");
    const offenders: string[] = [];
    const walk = (directory: string, relative: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith("_")) {
          offenders.push(`${relative}${entry.name}`);
        }
        if (entry.isDirectory()) {
          walk(resolve(directory, entry.name), `${relative}${entry.name}/`);
        }
      }
    };
    walk(dist, "");
    expect(offenders).toEqual([]);
  });

  it("ships the model artifact the self-check expects, or none at all", () => {
    // The self-check compares against spans generated from a specific checkpoint. If the bundled
    // manifest names a different artifact, a green self-check would prove nothing.
    const manifestPath = resolve(process.cwd(), "dist", "assets", "model", "runtime_manifest.json");
    let manifest: { artifact?: string; threshold?: number } | null = null;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      // A missing model is a supported configuration: the extension runs on rules alone.
      return;
    }
    const diagnostics = readFileSync(resolve(process.cwd(), "src", "diagnostics.ts"), "utf8");
    expect(manifest?.artifact).toBeTypeOf("string");
    expect(
      diagnostics.includes(`artifact: ${manifest?.artifact}`),
      `src/diagnostics.ts records different expectations than dist ships (${manifest?.artifact}). ` +
        "Regenerate with: node scripts/emit-selfcheck-expectations.mjs",
    ).toBe(true);
    expect(diagnostics).toContain(`threshold ${manifest?.threshold}`);
  });
});
