import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createScannerController,
  createScannerOptionsReader,
  type ScannerService,
} from "../src/scanner.js";
import type { CustomTermsStore } from "../src/shared/custom-terms.js";
import { scanPlainText } from "../src/scanner/scan.js";
import type { FileScanOptions, FileScanResult } from "../src/scanner/types.js";

const scannerHtmlPath = resolve(process.cwd(), "src", "scanner.html");
const scannerCssPath = resolve(process.cwd(), "src", "scanner.css");

function mountScanner(): void {
  const html = readFileSync(scannerHtmlPath, "utf8");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script").forEach((script) => script.remove());
  document.body.replaceChildren(...Array.from(parsed.body.childNodes, (node) => document.importNode(node, true)));
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing #${id}`);
  }
  return element as T;
}

function fakeFile(): File {
  return { name: "synthetic.txt", size: 12, type: "text/plain" } as File;
}

function scannerService(result: FileScanResult): ScannerService {
  return {
    scan: vi.fn(async () => result),
    cancel: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("local scanner page", () => {
  it("does not inherit webpage allowlists or category policies into file scanning", async () => {
    const store = {
      read: async () => ({
        ok: true as const,
        terms: [{ value: "青岚项目", group: "project" as const }],
        mode: "replace" as const,
        allowlistedTerms: ["13800138000", "青岚项目"],
        categoryPolicies: [{ kind: "phone" as const, action: "replace" as const }],
      }),
    } as unknown as CustomTermsStore;

    const options = await createScannerOptionsReader(store)();
    expect(options.allowlistedTerms).toEqual([]);
    expect(options.categoryPolicies).toEqual([]);
    expect(options.detectionProfile).toBe("balanced");
    expect(scanPlainText("电话：13800138000，项目：青岚项目", options).findings).toEqual([
      { kind: "phone", count: 1 },
      { kind: "custom_term", count: 1 },
    ]);
  });

  it("keeps the image preview visually hidden until a safe image derivative exists", () => {
    expect(readFileSync(scannerCssPath, "utf8")).toContain(".scan-image-preview[hidden]");
  });

  it("shows 扫描未跑神经模型 when local_neural is requested but unused", async () => {
    mountScanner();
    const store = {
      read: async () => ({
        ok: true as const,
        terms: [],
        mode: "replace" as const,
        detectionProfile: "balanced" as const,
        semanticReview: "local_neural" as const,
      }),
    } as unknown as CustomTermsStore;
    const service = scannerService({
      status: "clean",
      format: "text",
      coverage: "complete",
      findings: [],
      summary: {},
    });
    const controller = createScannerController(document, service, createScannerOptionsReader(store));
    await controller.initialize();
    await controller.scan(fakeFile());

    const notice = byId<HTMLElement>("scan-neural-notice");
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe("扫描未跑神经模型");
    expect(byId<HTMLElement>("scan-status").textContent).toContain("未发现");
    expect(byId<HTMLButtonElement>("download-redacted").disabled).toBe(true);
    controller.dispose();
  });

  it("keeps download disabled until a completed scan has a safe derivative", async () => {
    mountScanner();
    const service = scannerService({
      status: "sensitive",
      format: "text",
      coverage: "complete",
      findings: [{ kind: "phone", count: 1 }],
      summary: {},
      redactedText: "电话：[[PHONE_001]]",
    });
    const controller = createScannerController(document, service, async (): Promise<FileScanOptions> => ({}));
    await controller.initialize();

    expect(byId<HTMLButtonElement>("download-redacted").disabled).toBe(true);
    await controller.scan(fakeFile());

    expect(byId<HTMLButtonElement>("download-redacted").disabled).toBe(false);
    expect(byId<HTMLElement>("scan-status").textContent).toContain("已发现");
    expect(byId<HTMLElement>("scan-preview").textContent).toContain("[[PHONE_001]]");
    controller.dispose();
  });

  it("renders partial PDF coverage without calling it clean or enabling a download", async () => {
    mountScanner();
    const service = scannerService({
      status: "partial",
      format: "pdf",
      coverage: "partial",
      findings: [],
      summary: { reason: "pdf_without_text", pagesWithText: 0, pagesWithoutText: 1 },
    });
    const controller = createScannerController(document, service, async (): Promise<FileScanOptions> => ({}));
    await controller.initialize();
    await controller.scan(fakeFile());

    expect(byId<HTMLElement>("scan-status").textContent).toContain("部分扫描");
    expect(byId<HTMLElement>("scan-coverage").textContent).toContain("PDF 文本层检查");
    expect(byId<HTMLElement>("scan-coverage").textContent).not.toContain("完整扫描");
    expect(byId<HTMLElement>("scan-coverage").textContent).toContain("没有可提取的文本层");
    expect(byId<HTMLButtonElement>("download-redacted").disabled).toBe(true);
    controller.dispose();
  });

  it("labels a text-native PDF as text-layer-only rather than a complete scan", async () => {
    mountScanner();
    const service = scannerService({
      status: "partial",
      format: "pdf",
      coverage: "partial",
      findings: [{ kind: "phone", count: 1 }],
      summary: { reason: "pdf_text_layer_only", pagesWithText: 1, pagesWithoutText: 0 },
    });
    const controller = createScannerController(document, service, async (): Promise<FileScanOptions> => ({}));
    await controller.initialize();
    await controller.scan(fakeFile());

    const coverage = byId<HTMLElement>("scan-coverage").textContent ?? "";
    expect(byId<HTMLElement>("scan-status").textContent).toContain("部分扫描");
    expect(coverage).toContain("PDF 文本层检查");
    expect(coverage).toContain("图片、扫描页和嵌入内容未涵盖");
    expect(coverage).not.toContain("完整扫描");
    expect(byId<HTMLButtonElement>("download-redacted").disabled).toBe(true);
    controller.dispose();
  });

  it("requires an explicit local acknowledgement before downloading a review-required text derivative", async () => {
    mountScanner();
    const service = scannerService({
      status: "partial",
      format: "text",
      coverage: "partial",
      findings: [{ kind: "person_name", count: 1 }],
      summary: { reason: "review_required" },
      requiresReview: true,
      redactedText: "请联系 [[PERSON_001]]。",
    });
    const controller = createScannerController(document, service, async (): Promise<FileScanOptions> => ({}));
    await controller.initialize();
    await controller.scan(fakeFile());

    expect(byId<HTMLElement>("scan-status").textContent).toContain("需复核");
    expect(byId<HTMLButtonElement>("acknowledge-review").hidden).toBe(false);
    expect(byId<HTMLButtonElement>("download-redacted").disabled).toBe(true);
    expect(byId<HTMLButtonElement>("acknowledge-review").textContent).toBe("确认结果");
    byId<HTMLButtonElement>("acknowledge-review").click();
    expect(byId<HTMLButtonElement>("download-redacted").disabled).toBe(false);
    expect(byId<HTMLElement>("scan-status").textContent).toContain("已确认");
    controller.dispose();
  });

  it("requires acknowledgement of incomplete coverage before downloading a partial text derivative", async () => {
    mountScanner();
    const service = scannerService({
      status: "partial",
      format: "pdf",
      coverage: "partial",
      findings: [{ kind: "phone", count: 1 }],
      summary: { reason: "pdf_text_layer_only", pagesWithText: 1, pagesWithoutText: 0 },
      redactedText: "电话：[[PHONE_001]]",
    });
    const download = vi.fn();
    const controller = createScannerController(document, service, async (): Promise<FileScanOptions> => ({}), download);
    await controller.initialize();
    await controller.scan(fakeFile());

    expect(byId<HTMLButtonElement>("download-redacted").disabled).toBe(true);
    expect(byId<HTMLButtonElement>("acknowledge-review").hidden).toBe(false);
    expect(byId<HTMLButtonElement>("acknowledge-review").textContent).toBe("确认扫描范围");
    byId<HTMLButtonElement>("download-redacted").click();
    expect(download).not.toHaveBeenCalled();
    byId<HTMLButtonElement>("acknowledge-review").click();
    expect(byId<HTMLButtonElement>("download-redacted").disabled).toBe(false);
    expect(byId<HTMLElement>("scan-status").textContent).toContain("已确认扫描范围");
    byId<HTMLButtonElement>("download-redacted").click();
    expect(download).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("clears transient result text and ignores a late scan after cancellation", async () => {
    mountScanner();
    let resolveScan: ((result: FileScanResult) => void) | undefined;
    const service: ScannerService = {
      scan: vi.fn(() => new Promise<FileScanResult>((resolve) => { resolveScan = resolve; })),
      cancel: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
    const controller = createScannerController(document, service, async (): Promise<FileScanOptions> => ({}));
    await controller.initialize();
    const pending = controller.scan(fakeFile());
    await Promise.resolve();
    await Promise.resolve();

    byId<HTMLButtonElement>("clear-scan").click();
    resolveScan?.({
      status: "sensitive",
      format: "text",
      coverage: "complete",
      findings: [{ kind: "phone", count: 1 }],
      summary: {},
      redactedText: "电话：[[PHONE_001]]",
    });
    await pending;

    expect(byId<HTMLElement>("scan-status").textContent).toContain("未选择文件");
    expect(byId<HTMLElement>("scan-preview").textContent).toBe("");
    expect(byId<HTMLButtonElement>("download-redacted").disabled).toBe(true);
    expect(service.cancel).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("does not gate a complete sensitive download on skipped local_neural review", async () => {
    mountScanner();
    const store = {
      read: async () => ({
        ok: true as const,
        terms: [],
        mode: "replace" as const,
        allowlistedTerms: [],
        detectionProfile: "balanced" as const,
        semanticReview: "local_neural" as const,
      }),
    } as unknown as CustomTermsStore;
    const service = scannerService({
      status: "sensitive",
      format: "text",
      coverage: "complete",
      findings: [{ kind: "phone", count: 1 }],
      summary: {},
      redactedText: "电话：[[PHONE_001]]",
    });
    const controller = createScannerController(document, service, createScannerOptionsReader(store));
    await controller.initialize();
    await controller.scan(fakeFile());

    const notice = byId<HTMLElement>("scan-neural-notice");
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe("扫描未跑神经模型");
    expect(byId<HTMLButtonElement>("acknowledge-review").hidden).toBe(true);
    expect(byId<HTMLButtonElement>("download-redacted").disabled).toBe(false);
    controller.dispose();
  });
});
