// Where offline harnesses put their temporary esbuild bundles.
//
// Not `dist/`, which is what every one of them used to do. Chrome refuses to load an extension
// directory containing a file whose name starts with `_` — those names are reserved — so a harness
// bundle sitting in `dist/` makes the built extension uninstallable:
//
//   Cannot load extension with file or directory name __neural-eval.mjs.
//   Filenames starting with "_" are reserved for use by the system.
//
// That is not hypothetical. It is what blocked the first real-browser run of the release gate, and
// it would equally break a Web Store upload. The failure is also easy to miss: a crashed harness
// leaves the file behind, and the next `npm run build` cleans it up again, so the breakage comes and
// goes depending on what ran last.
//
// Keeping the bundles outside the packaged directory removes the failure mode instead of relying on
// each harness to clean up after itself.
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path for a harness scratch file, with the directory created. */
export async function harnessBundle(name) {
  const directory = resolve(root, ".harness-tmp");
  await mkdir(directory, { recursive: true });
  return resolve(directory, name);
}

/** Names Chrome reserves inside an extension directory. */
export function reservedExtensionName(name) {
  return name.startsWith("_");
}
