// Entry point that exposes the browser inference stack for out-of-browser smoke testing.
//
// Bundled by scripts/smoke-neural-runner.mjs so the smoke test drives exactly the modules the
// extension ships, including `ort-runner.ts` — the one piece the fixture-replay suites cannot
// reach, because it is the boundary with ONNX Runtime itself.
export { createOrtRunner } from "../../src/shared/neural/ort-runner.js";
export { predictEntities } from "../../src/shared/neural/session.js";
export { createVocabulary, tokenize } from "../../src/shared/neural/tokenizer.js";
