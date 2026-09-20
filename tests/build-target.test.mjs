import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";

import { resolveBuildDirectory } from "../scripts/build-target.mjs";
import { resolveBrowserTestDist } from "./browser/launch-extension.mjs";

const ROOT = resolve("C:/workspace/project");

test("browser harness prefers the explicit isolated test directory", () => {
  const isolated = resolve(ROOT, ".harness-tmp/runtime-evidence");
  assert.equal(
    resolveBrowserTestDist({ PRIVATE_COMPOSER_TEST_DIST: isolated }),
    isolated,
  );
});

test("browser harness falls back to the repository dist directory", () => {
  assert.equal(
    resolveBrowserTestDist({}, ROOT),
    resolve(ROOT, "dist"),
  );
});

test("uses the legacy dist directory when no isolated output is requested", () => {
  assert.equal(resolveBuildDirectory(ROOT), resolve(ROOT, "dist"));
});

test("accepts a non-empty isolated directory under .harness-tmp", () => {
  assert.equal(
    resolveBuildDirectory(ROOT, ".harness-tmp/runtime-boundary-test"),
    resolve(ROOT, ".harness-tmp/runtime-boundary-test"),
  );
});

test("rejects isolated output outside the workspace harness directory", () => {
  assert.throws(
    () => resolveBuildDirectory(ROOT, "C:/elsewhere/extension"),
    /PRIVATE_COMPOSER_BUILD_DIR must point to a fresh directory under \.harness-tmp/,
  );
});

test("rejects the root dist and the protected release-candidate directory", () => {
  assert.throws(
    () => resolveBuildDirectory(ROOT, "dist"),
    /PRIVATE_COMPOSER_BUILD_DIR must point to a fresh directory under \.harness-tmp/,
  );
  assert.throws(
    () => resolveBuildDirectory(ROOT, ".harness-tmp/r14-release-candidate-20260911-isolated"),
    /protected release-candidate directory/,
  );
});
