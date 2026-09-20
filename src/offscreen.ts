/*
 * Offscreen host for the local student model.
 *
 * Why an offscreen document and not somewhere simpler:
 *  - A content script runs under the *page's* CSP, and the extension's `wasm-unsafe-eval` only
 *    covers extension pages. WASM there is at the mercy of whatever CSP DeepSeek or ChatGPT ships.
 *  - The service worker is torn down when idle, so the model would reload on a timer.
 *  - An offscreen document is an extension page that stays alive, which is exactly the
 *    requirement.
 *
 * The model is loaded lazily on the first request and kept. Transient load failures are retried
 * a bounded number of times; once attempts are exhausted the document reports `ready: false`
 * and answers every request with an error. In `local_neural` mode, the content-side final-draft
 * gate surfaces that failure and requires cancellation or an explicit one-time raw send; it
 * does not silently downgrade an unreviewed send to rules alone.
 */

import { createNeuralHintCache } from "./shared/neural/hint-cache.js";
import {
  NEURAL_REVIEW_RESULT,
  NEURAL_REVIEW_STATUS,
  isNeuralReviewExec,
  type NeuralReviewResult,
  type NeuralReviewStatus,
} from "./shared/neural/messages.js";
import { createModelLoader } from "./shared/neural/model-loader.js";
import { createOrtRunner, type OrtRunner } from "./shared/neural/ort-runner.js";
import { reviewWithModel } from "./shared/neural/review.js";
import { parseRuntimeManifest } from "./shared/neural/runtime-manifest.js";

import { createVocabulary, type BertVocabulary } from "./shared/neural/tokenizer.js";
import type { SemanticHint } from "./shared/semantic-review.js";

const MODEL_DIRECTORY = "assets/model";
const WASM_DIRECTORY = "vendor/onnxruntime/";
/*
 * Held in a variable rather than written inline, so neither TypeScript nor esbuild tries to
 * resolve it at build time: the file only exists in `dist`, copied there by scripts/build.mjs.
 * At runtime the offscreen document is an ES module at the extension root, so this resolves to
 * chrome-extension://<id>/vendor/onnxruntime/ort.wasm.bundle.min.mjs.
 */
const ORT_MODULE_PATH = "./vendor/onnxruntime/ort.wasm.bundle.min.mjs";

type LoadedModel = {
  runner: OrtRunner;
  vocabulary: BertVocabulary;
  labels: string[];
  threshold: number;
  maxLength: number;
  stride: number;
};

// Results are cached here too. The content script has its own cache, but a second tab asking
// about the same draft should not pay for a second pass.
const resultCache = createNeuralHintCache(16);

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

async function loadModel(): Promise<LoadedModel> {
  const manifest = parseRuntimeManifest(
    await fetchJson(`${MODEL_DIRECTORY}/runtime_manifest.json`),
  );
  const labels = Object.entries(manifest.labels)
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([, label]) => label);
  const vocabularyTokens = await fetchJson<string[]>("assets/model/vocab.json");
  const runner = await createOrtRunner({
    model: chrome.runtime.getURL(`${MODEL_DIRECTORY}/model.int8.onnx`),
    wasmDirectoryUrl: chrome.runtime.getURL(WASM_DIRECTORY),
    loadOrt: () => import(ORT_MODULE_PATH) as never,
  });
  return {
    runner,
    vocabulary: createVocabulary(vocabularyTokens),
    labels,
    // Threshold, window length and stride are part of the artifact and were selected during the
    // offline evaluation. The parser refuses a missing key rather than substituting a default
    // that would desync the browser from the evaluated behaviour.
    threshold: manifest.threshold,
    maxLength: manifest.max_length,
    stride: manifest.stride,
  };
}

const modelLoader = createModelLoader({ load: loadModel, maxAttempts: 3 });

async function review(text: string, loaded: LoadedModel): Promise<SemanticHint[]> {
  // Shared with the offline evaluation harness, so the numbers that justify shipping the model
  // describe the code the extension actually runs.
  return reviewWithModel(
    text,
    {
      vocabulary: loaded.vocabulary,
      labels: loaded.labels,
      threshold: loaded.threshold,
      maxLength: loaded.maxLength,
      stride: loaded.stride,
    },
    loaded.runner,
  );
}

function statusMessage(): NeuralReviewStatus {
  return {
    type: NEURAL_REVIEW_STATUS,
    ready: modelLoader.model !== null,
    loadMilliseconds: modelLoader.model?.runner.loadMilliseconds ?? null,
    error: modelLoader.loadError,
  };
}

/*
 * 运行时状态**不在这里**发布。
 *
 * 曾经在这里写 `chrome.storage.session`，在真实 Chrome 里实测无效——offscreen 文档既不被 Playwright
 * 当作 page 也不当作 backgroundPage，写入既不生效也难以继续观测。发布点移到了 `neural-host.ts`：
 * service worker 中转每一次复核、拥有 offscreen 文档的生命周期，是明确受信的上下文，写入可验证。
 *
 * 这里仍然保留 `statusMessage()`，因为自检页会显式查询它，而那条路径要的是权威的加载耗时与错误原文。
 */

export function shouldPersistOffscreenReview(elapsedMs: number, deadlineMs: number): boolean {
  return elapsedMs <= deadlineMs;
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (isNeuralReviewExec(message)) {
    void (async () => {
      const started = Date.now();
      // Same 15s wall as neural-host.ts / client.ts; those drop late replies.
      const REVIEW_DEADLINE_MS = 15_000;
      const cached = resultCache.get(message.text);
      if (cached !== undefined) {
        sendResponse({
          type: NEURAL_REVIEW_RESULT,
          requestId: message.requestId,
          ok: true,
          hints: [...cached],
          elapsedMs: 0,
        } satisfies NeuralReviewResult);
        return;
      }
      const loaded = await modelLoader.ensure();
      if (loaded === null) {
        sendResponse({
          type: NEURAL_REVIEW_RESULT,
          requestId: message.requestId,
          ok: false,
          error: modelLoader.loadError ?? "model unavailable",
        } satisfies NeuralReviewResult);
        return;
      }
      try {
        const hints = await review(message.text, loaded);
        const elapsedMs = Date.now() - started;
        if (shouldPersistOffscreenReview(elapsedMs, REVIEW_DEADLINE_MS)) {
          resultCache.put(message.text, hints);
        }
        sendResponse({
          type: NEURAL_REVIEW_RESULT,
          requestId: message.requestId,
          ok: true,
          hints,
          elapsedMs,
        } satisfies NeuralReviewResult);
      } catch (error: unknown) {
        sendResponse({
          type: NEURAL_REVIEW_RESULT,
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies NeuralReviewResult);
      }
    })();
    return true;
  }
  if ((message as { type?: unknown })?.type === NEURAL_REVIEW_STATUS) {
    sendResponse(statusMessage());
    return false;
  }
  return false;
});

// Warm the model as soon as the document exists, so the first real draft does not pay the
// cold start. Failure is recorded, not thrown.
void modelLoader.ensure();
