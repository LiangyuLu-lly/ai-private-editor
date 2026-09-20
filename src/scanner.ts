import {
  createChromeCustomTermsStore,
  DEFAULT_ADVANCED_SETTINGS,
  type CustomTermsStore,
} from "./shared/custom-terms.js";
import { createLocalStatisticalSemanticProvider } from "./shared/semantic-review.js";
import type { DetectionKind } from "./shared/types.js";
import { createLocalPdfWorkerUrl, detectFileFormat, scanFile, setLocalPdfWorkerUrl } from "./scanner/extractors.js";
import { scanImage, type ImageScanResult } from "./scanner/image.js";
import { createLocalOcrEngine, createLocalOcrResourceUrls, type LocalOcrEngine } from "./scanner/ocr.js";
import { createRedactedTextBlob } from "./scanner/scan.js";
import type { FileScanOptions, FileScanResult, LocalImageFile, LocalScanFile } from "./scanner/types.js";

type ScannerResult = FileScanResult | ImageScanResult;

export type ScannerService = {
  scan(file: File, options: FileScanOptions, signal: AbortSignal): Promise<ScannerResult>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
};

export type ScannerController = {
  initialize(): Promise<void>;
  scan(file: File): Promise<void>;
  dispose(): void;
};

type ScannerPageOptions = FileScanOptions & {
  readonly neuralReviewSkipped?: boolean;
};
type ScannerOptionsReader = () => Promise<ScannerPageOptions>;
type DownloadHandler = (blob: Blob, filename: string) => void;

const KIND_LABELS: Record<DetectionKind, string> = {
  api_key: "API 密钥",
  access_token: "访问令牌",
  private_key: "私钥",
  connection_string: "连接串",
  phone: "手机号",
  email: "邮箱",
  china_id: "身份证号",
  bank_card: "银行卡号",
  unified_social_credit_code: "统一社会信用代码",
  passport: "护照号",
  license_plate: "车牌号",
  ipv4: "IP 地址",
  ipv6: "IPv6 地址",
  local_path: "本地路径",
  custom_term: "自定义词",
  person_name: "姓名",
  address: "地址",
  account: "账号",
  labeled_identifier: "标识信息",
  credential: "凭证",
  private_date: "出生日期",
  private_url: "私密分享链接",
  mac_address: "MAC 地址",
  bank_account: "银行账户",
};

const REASON_MESSAGES = {
  text_limit: "提取文本超过本地扫描上限。",
  file_limit: "文件超过 10 MiB 本地扫描上限。",
  image_limit: "图片像素数超过本地 OCR 上限。",
  unsupported_format: "此格式当前不能本地扫描。",
  parse_failed: "文件无法安全解析。",
  pdf_text_layer_only: "仅检查 PDF 可提取文本层；图片、扫描页和嵌入内容未涵盖。",
  pdf_without_text: "PDF 没有可提取的文本层。",
  page_limit: "PDF 超出本地页数扫描上限。",
  embedded_media: "Office 文件含未提取的内嵌媒体或对象（图片、OLE 对象、缩略图等）。",
  ocr_low_confidence: "OCR 置信度不足。",
  redaction_unavailable: "已识别敏感内容，但无法生成可信的打码副本（图片方向不正立或识别结果不完整）；请手动处理原图。",
  review_required: "存在需要人工确认的语义或类别命中。",
  task_cancelled: "扫描已取消。",
} as const;

function requiredElement<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing #${id}`);
  }
  return element as T;
}

function abortError(): Error {
  const error = new Error("Task cancelled");
  error.name = "AbortError";
  return error;
}

function localScanFile(file: File): LocalScanFile {
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    arrayBuffer: () => file.arrayBuffer(),
    text: () => file.text(),
  };
}

function localImageFile(file: File): LocalImageFile {
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    arrayBuffer: () => file.arrayBuffer(),
    blob: file,
  };
}

function runtimeUrl(path: string): string {
  return typeof chrome !== "undefined" && typeof chrome.runtime?.getURL === "function"
    ? chrome.runtime.getURL(path)
    : path;
}

export function createLocalScannerService(getUrl: (path: string) => string = runtimeUrl): ScannerService {
  // 与 OCR 资源一致地硬失败：非扩展本地 URL 直接拒绝，不静默跳过设置。
  // 静默跳过会让 pdf.js 回退到自己的默认解析逻辑，脱离本地资源校验。
  setLocalPdfWorkerUrl(createLocalPdfWorkerUrl(getUrl));
  let engine: LocalOcrEngine | undefined;
  let enginePromise: Promise<LocalOcrEngine> | undefined;
  let generation = 0;

  const ensureEngine = async (): Promise<LocalOcrEngine> => {
    if (engine !== undefined) {
      return engine;
    }
    const expectedGeneration = generation;
    enginePromise ??= createLocalOcrEngine(createLocalOcrResourceUrls(getUrl));
    const created = await enginePromise;
    if (expectedGeneration !== generation) {
      await created.terminate();
      enginePromise = undefined;
      throw abortError();
    }
    engine = created;
    return created;
  };

  const stopEngine = async (): Promise<void> => {
    generation += 1;
    const active = engine;
    engine = undefined;
    enginePromise = undefined;
    if (active !== undefined) {
      await active.terminate();
    }
  };

  return {
    async scan(file, options, signal): Promise<ScannerResult> {
      if (signal.aborted) {
        throw abortError();
      }
      if (detectFileFormat(file) !== "image") {
        const result = await scanFile(localScanFile(file), options);
        if (signal.aborted) {
          throw abortError();
        }
        return result;
      }

      const activeEngine = await ensureEngine();
      if (signal.aborted) {
        throw abortError();
      }
      const result = await scanImage(localImageFile(file), activeEngine, options);
      if (signal.aborted) {
        throw abortError();
      }
      return result;
    },
    cancel: stopEngine,
    dispose: stopEngine,
  };
}

export function createScannerOptionsReader(store: CustomTermsStore): ScannerOptionsReader {
  return async (): Promise<ScannerPageOptions> => {
    const settings = await store.read();
    if (!settings.ok) {
      throw new Error("Unable to read local protection settings");
    }
    const detectionProfile = settings.detectionProfile ?? DEFAULT_ADVANCED_SETTINGS.detectionProfile;
    const semanticReview = settings.semanticReview ?? DEFAULT_ADVANCED_SETTINGS.semanticReview;
    const semanticReviewProvider = detectionProfile === "balanced" && semanticReview === "local_statistical"
      ? createLocalStatisticalSemanticProvider()
      : undefined;
    return {
      customTerms: settings.terms.map((term) => term.value),
      // Webpage-specific release rules must not weaken a file scan.
      allowlistedTerms: [],
      categoryPolicies: [],
      detectionProfile,
      replacementStyle: settings.replacementStyle ?? DEFAULT_ADVANCED_SETTINGS.replacementStyle,
      semanticReviewProvider,
      neuralReviewSkipped: detectionProfile === "balanced" && semanticReview === "local_neural",
    };
  };
}

function resultPayload(result: ScannerResult): { blob: Blob; filename: string; previewText?: string; previewImage?: Blob } | null {
  if (result.status !== "sensitive" && result.status !== "partial") {
    return null;
  }
  if (result.findings.length === 0) {
    return null;
  }
  if ("redactedImage" in result && result.redactedImage !== undefined) {
    return { blob: result.redactedImage, filename: "ai-private-redacted.png", previewImage: result.redactedImage };
  }
  if ("redactedText" in result && result.redactedText !== undefined) {
    return {
      blob: createRedactedTextBlob(result.redactedText),
      filename: "ai-private-redacted.txt",
      previewText: result.redactedText,
    };
  }
  return null;
}

function requiresDownloadAcknowledgement(
  result: ScannerResult,
  payload: ReturnType<typeof resultPayload>,
): boolean {
  return payload !== null && result.coverage === "partial";
}

function coverageMessage(result: ScannerResult): string {
  if (result.format === "pdf") {
    const reason = result.summary.reason;
    return `PDF 文本层检查：${reason === undefined ? "图片、扫描页和嵌入内容未涵盖。" : REASON_MESSAGES[reason]}`;
  }
  if (result.coverage === "complete") {
    return "完整扫描：已覆盖此文件的可读取内容。";
  }
  if (result.coverage === "partial") {
    const reason = result.summary.reason;
    const secondaryReason = result.summary.secondaryReason;
    const primary = reason === undefined ? "存在未覆盖内容。" : REASON_MESSAGES[reason];
    return `部分扫描：${primary}${secondaryReason === undefined ? "" : REASON_MESSAGES[secondaryReason]}`;
  }
  const reason = result.summary.reason;
  return reason === undefined ? "无法扫描。" : `无法扫描：${REASON_MESSAGES[reason]}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function createScannerController(
  document: Document,
  service: ScannerService = createLocalScannerService(),
  getOptions: ScannerOptionsReader = createScannerOptionsReader(createChromeCustomTermsStore()),
  download: DownloadHandler = downloadBlob,
): ScannerController {
  const fileInput = requiredElement<HTMLInputElement>(document, "scan-file");
  const selectedFile = requiredElement<HTMLElement>(document, "selected-file");
  const status = requiredElement<HTMLElement>(document, "scan-status");
  const neuralNotice = requiredElement<HTMLElement>(document, "scan-neural-notice");
  const coverage = requiredElement<HTMLElement>(document, "scan-coverage");
  const findings = requiredElement<HTMLUListElement>(document, "scan-findings");
  const preview = requiredElement<HTMLElement>(document, "scan-preview");
  const imagePreview = requiredElement<HTMLImageElement>(document, "scan-image-preview");
  const acknowledgeReviewButton = requiredElement<HTMLButtonElement>(document, "acknowledge-review");
  const downloadButton = requiredElement<HTMLButtonElement>(document, "download-redacted");
  const clearButton = requiredElement<HTMLButtonElement>(document, "clear-scan");
  let initialized = false;
  let disposed = false;
  let revision = 0;
  let activeController: AbortController | undefined;
  let currentResult: ScannerResult | undefined;
  let reviewAcknowledged = false;
  let neuralReviewSkipped = false;
  let imagePreviewUrl: string | undefined;

  const revokeImagePreview = (): void => {
    if (imagePreviewUrl !== undefined) {
      URL.revokeObjectURL(imagePreviewUrl);
      imagePreviewUrl = undefined;
    }
    imagePreview.removeAttribute("src");
    imagePreview.hidden = true;
  };

  const clearView = (): void => {
    currentResult = undefined;
    reviewAcknowledged = false;
    neuralReviewSkipped = false;
    selectedFile.textContent = "未选择文件";
    status.textContent = "未选择文件";
    status.dataset.state = "neutral";
    neuralNotice.hidden = true;
    coverage.textContent = "支持文本、DOCX、XLSX、PDF 文本层和 PNG/JPEG/WebP。";
    findings.replaceChildren();
    const empty = document.createElement("li");
    empty.className = "empty-findings";
    empty.textContent = "尚无扫描结果。";
    findings.append(empty);
    preview.textContent = "";
    revokeImagePreview();
    downloadButton.disabled = true;
    acknowledgeReviewButton.hidden = true;
    acknowledgeReviewButton.disabled = true;
    acknowledgeReviewButton.textContent = "确认扫描范围";
    clearButton.disabled = true;
  };

  const renderResult = (result: ScannerResult): void => {
    currentResult = result;
    const payload = resultPayload(result);
    const count = result.findings.reduce((total, finding) => total + finding.count, 0);
    status.dataset.state = result.status === "unscannable" ? "error" : result.status === "partial" ? "warning" : "neutral";
    status.textContent = result.requiresReview === true
      ? `已识别 ${count} 项需复核信息。`
      : result.status === "sensitive"
      ? `已发现 ${count} 项敏感信息。`
      : result.status === "clean"
        ? "未发现已识别敏感信息。"
        : result.status === "partial"
          ? "部分扫描完成。"
          : "无法扫描此文件。";
    coverage.textContent = coverageMessage(result);
    findings.replaceChildren();
    if (result.findings.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty-findings";
      empty.textContent = result.status === "clean" ? "未发现已识别敏感项。" : "未生成敏感项摘要。";
      findings.append(empty);
    } else {
      result.findings.forEach((finding) => {
        const item = document.createElement("li");
        const label = document.createElement("span");
        const count = document.createElement("span");
        label.textContent = KIND_LABELS[finding.kind];
        count.textContent = `${finding.count} 项`;
        item.append(label, count);
        findings.append(item);
      });
    }
    preview.textContent = payload?.previewText?.slice(0, 4_000) ?? "";
    revokeImagePreview();
    if (payload?.previewImage !== undefined) {
      imagePreviewUrl = URL.createObjectURL(payload.previewImage);
      imagePreview.src = imagePreviewUrl;
      imagePreview.hidden = false;
    }
    const acknowledgementRequired = requiresDownloadAcknowledgement(result, payload);
    acknowledgeReviewButton.hidden = !acknowledgementRequired;
    acknowledgeReviewButton.disabled = !acknowledgementRequired;
    acknowledgeReviewButton.textContent = result.requiresReview === true ? "确认结果" : "确认扫描范围";
    downloadButton.disabled = payload === null || (acknowledgementRequired && !reviewAcknowledged);
    neuralNotice.hidden = !neuralReviewSkipped;
    if (neuralReviewSkipped && status.dataset.state === "neutral") {
      status.dataset.state = "warning";
    }
    clearButton.disabled = false;
  };

  const clear = (): void => {
    revision += 1;
    activeController?.abort();
    activeController = undefined;
    fileInput.value = "";
    clearView();
    void service.cancel();
  };

  const onFileChange = (): void => {
    const file = fileInput.files?.[0];
    if (file !== undefined) {
      void controller.scan(file);
    }
  };

  const onDownload = (): void => {
    if (currentResult === undefined) {
      return;
    }
    const payload = resultPayload(currentResult);
    if (payload !== null && (!requiresDownloadAcknowledgement(currentResult, payload) || reviewAcknowledged)) {
      download(payload.blob, payload.filename);
    }
  };

  const onAcknowledgeReview = (): void => {
    if (currentResult === undefined) {
      return;
    }
    const payload = resultPayload(currentResult);
    if (!requiresDownloadAcknowledgement(currentResult, payload)) {
      return;
    }
    reviewAcknowledged = true;
    acknowledgeReviewButton.disabled = true;
    downloadButton.disabled = false;
    status.textContent = currentResult.requiresReview === true
      ? "已确认当前识别结果，可下载处理副本。"
      : "已确认扫描范围，可下载处理副本。";
    status.dataset.state = "warning";
  };

  const controller: ScannerController = {
    async initialize(): Promise<void> {
      if (initialized || disposed) {
        return;
      }
      initialized = true;
      fileInput.addEventListener("change", onFileChange);
      clearButton.addEventListener("click", clear);
      acknowledgeReviewButton.addEventListener("click", onAcknowledgeReview);
      downloadButton.addEventListener("click", onDownload);
      clearView();
    },
    async scan(file): Promise<void> {
      if (disposed) {
        return;
      }
      revision += 1;
      const currentRevision = revision;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      currentResult = undefined;
      reviewAcknowledged = false;
      neuralReviewSkipped = false;
      selectedFile.textContent = file.name;
      status.textContent = "正在本地扫描…";
      status.dataset.state = "neutral";
      neuralNotice.hidden = true;
      coverage.textContent = "文件内容仅保留在本次扫描内存中。";
      findings.replaceChildren();
      preview.textContent = "";
      revokeImagePreview();
      downloadButton.disabled = true;
      acknowledgeReviewButton.hidden = true;
      acknowledgeReviewButton.disabled = true;
      acknowledgeReviewButton.textContent = "确认扫描范围";
      clearButton.disabled = false;

      try {
        const pageOptions = await getOptions();
        const { neuralReviewSkipped: skippedNeuralReview, ...options } = pageOptions;
        neuralReviewSkipped = skippedNeuralReview === true;
        const result = await service.scan(file, options, controller.signal);
        if (disposed || controller.signal.aborted || currentRevision !== revision) {
          return;
        }
        renderResult(result);
      } catch (error) {
        if (disposed || controller.signal.aborted || currentRevision !== revision || (error as Error).name === "AbortError") {
          return;
        }
        currentResult = undefined;
        status.textContent = "无法读取本地保护设置或扫描文件。";
        status.dataset.state = "error";
        coverage.textContent = "未生成处理副本。";
        downloadButton.disabled = true;
      } finally {
        if (activeController === controller) {
          activeController = undefined;
        }
      }
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      fileInput.removeEventListener("change", onFileChange);
      clearButton.removeEventListener("click", clear);
      acknowledgeReviewButton.removeEventListener("click", onAcknowledgeReview);
      downloadButton.removeEventListener("click", onDownload);
      clear();
      void service.dispose();
    },
  };

  return controller;
}

export async function bootstrapScanner(document: Document = window.document): Promise<ScannerController> {
  const controller = createScannerController(document);
  await controller.initialize();
  return controller;
}

function startScannerWhenReady(): void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }
  const start = (): void => {
    if (document.getElementById("scan-file")) {
      void bootstrapScanner();
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
    return;
  }
  start();
}

startScannerWhenReady();
