/*
 * ONNX Runtime Web adapter. Deliberately thin.
 *
 * Everything that can be wrong in a way tests can catch — tokenization, windowing, decoding,
 * stitching — lives in the sibling modules and is pinned by golden fixtures from the Python
 * pipeline. This file only marshals tensors and owns the session lifetime, so a browser is
 * needed to exercise it but very little can go silently wrong here.
 *
 * Runtime configuration notes:
 *  - Threads are forced to 1. ORT's threaded build needs SharedArrayBuffer, which needs
 *    cross-origin isolation (COOP/COEP). Extension pages are not cross-origin isolated, so
 *    asking for threads would either fail or fall back with a warning on every load.
 *  - `wasmPaths` must be an extension URL. The default resolves relative to the document,
 *    which in an offscreen document is not where the vendored binary lives.
 */

import type { InferenceRunner, LogitsTensor, ModelBatch } from "./session.js";

/** The subset of onnxruntime-web this adapter uses, so the import can stay dynamic. */
type OrtModule = {
  env: { wasm: { wasmPaths: string; numThreads: number; simd: boolean; proxy: boolean } };
  Tensor: new (type: "int64", data: BigInt64Array, dims: readonly number[]) => unknown;
  InferenceSession: {
    create(
      source: string | Uint8Array,
      options: { executionProviders: string[]; graphOptimizationLevel: string },
    ): Promise<OrtSession>;
  };
};

type OrtSession = {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
  release?(): Promise<void>;
};

export type OrtRunnerOptions = {
  /**
   * Extension URL of model.int8.onnx, or its bytes.
   *
   * The browser passes a URL, which ONNX Runtime fetches. Bytes exist for the out-of-browser
   * smoke test: Node's fetch does not accept `file:` URLs, so `scripts/smoke-neural-runner.mjs`
   * reads the artifact itself. ONNX Runtime accepts both natively.
   */
  model: string | Uint8Array;
  /** Extension URL of the directory holding ort-wasm-simd-threaded.wasm, with a trailing slash. */
  wasmDirectoryUrl: string;
  /** Dynamic import of onnxruntime-web, injected so tests can substitute a stub. */
  loadOrt: () => Promise<OrtModule>;
};

export type OrtRunner = InferenceRunner & {
  /** Milliseconds spent loading the session, for the latency budget. */
  readonly loadMilliseconds: number;
  dispose(): Promise<void>;
};

function toInt64Tensor(ort: OrtModule, rows: readonly number[][]): unknown {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const data = new BigInt64Array(height * width);
  for (let row = 0; row < height; row += 1) {
    const values = rows[row] as number[];
    for (let column = 0; column < width; column += 1) {
      data[row * width + column] = BigInt(values[column] as number);
    }
  }
  return new ort.Tensor("int64", data, [height, width]);
}

export async function createOrtRunner(options: OrtRunnerOptions): Promise<OrtRunner> {
  const ort = await options.loadOrt();
  ort.env.wasm.wasmPaths = options.wasmDirectoryUrl;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  // The proxy worker would need a web-accessible script URL; the offscreen document is
  // already off the critical path, so running in-document is simpler and equally safe.
  ort.env.wasm.proxy = false;

  const started = Date.now();
  const session = await ort.InferenceSession.create(options.model, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  const loadMilliseconds = Date.now() - started;

  return {
    loadMilliseconds,
    async run(batch: ModelBatch): Promise<LogitsTensor> {
      const outputs = await session.run({
        input_ids: toInt64Tensor(ort, batch.inputIds),
        attention_mask: toInt64Tensor(ort, batch.attentionMask),
        token_type_ids: toInt64Tensor(ort, batch.tokenTypeIds),
      });
      const logits = outputs["logits"];
      if (logits === undefined) {
        throw new Error(`Model produced no logits output; got ${Object.keys(outputs).join(", ")}`);
      }
      return { data: logits.data, dims: logits.dims };
    },
    async dispose(): Promise<void> {
      await session.release?.();
    },
  };
}
