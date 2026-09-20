/*
 * Bounded lazy model load with in-flight coalescing.
 *
 * A transient failure must not disable the offscreen document for its lifetime: the in-flight
 * promise is released on failure so a later ensure() can retry, up to maxAttempts. Success
 * clears loadError. Exhausted attempts stay fail-closed — callers still see null, never a
 * silent rules-only fallback.
 */

export type ModelLoaderOptions<T> = {
  readonly load: () => Promise<T>;
  readonly maxAttempts: number;
};

export type ModelLoader<T> = {
  ensure(): Promise<T | null>;
  readonly loadError: string | null;
  readonly model: T | null;
};

export function createModelLoader<T>(options: ModelLoaderOptions<T>): ModelLoader<T> {
  const { load, maxAttempts } = options;
  let model: T | null = null;
  let loadError: string | null = null;
  let inFlight: Promise<T | null> | null = null;
  let attempts = 0;

  const ensure = (): Promise<T | null> => {
    if (model !== null) {
      return Promise.resolve(model);
    }
    if (attempts >= maxAttempts) {
      return Promise.resolve(null);
    }
    if (inFlight !== null) {
      return inFlight;
    }
    inFlight = (async () => {
      try {
        const loaded = await load();
        model = loaded;
        loadError = null;
        return loaded;
      } catch (error: unknown) {
        attempts += 1;
        loadError = error instanceof Error ? error.message : String(error);
        inFlight = null;
        return null;
      }
    })();
    return inFlight;
  };

  return {
    ensure,
    get loadError() {
      return loadError;
    },
    get model() {
      return model;
    },
  };
}
