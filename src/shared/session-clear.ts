export const SESSION_CLEAR_SIGNAL_STORAGE_KEY = "sessionClearSignal";

export type SessionClearStorage = {
  writeValue(value: string): Promise<void>;
  subscribe(listener: (value: unknown) => void): () => void;
};

export type SessionClearSignal = {
  requestClear(): Promise<boolean>;
  subscribe(listener: () => void): () => void;
};

function createNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createSessionClearSignal(
  storage: SessionClearStorage,
  nextNonce: () => string = createNonce,
): SessionClearSignal {
  return {
    async requestClear(): Promise<boolean> {
      try {
        await storage.writeValue(nextNonce());
        return true;
      } catch {
        return false;
      }
    },
    subscribe(listener): () => void {
      return storage.subscribe((value) => {
        if (typeof value === "string" && value.length > 0) {
          listener();
        }
      });
    },
  };
}

function hasChromeStorage(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.storage?.local?.set === "function" &&
    typeof chrome.storage?.onChanged?.addListener === "function" &&
    typeof chrome.storage.onChanged.removeListener === "function"
  );
}

export function createChromeSessionClearSignal(): SessionClearSignal {
  if (!hasChromeStorage()) {
    return {
      requestClear: async () => false,
      subscribe: () => () => undefined,
    };
  }

  return createSessionClearSignal({
    async writeValue(value) {
      await chrome.storage.local.set({ [SESSION_CLEAR_SIGNAL_STORAGE_KEY]: value });
    },
    subscribe(listener) {
      const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
        if (areaName === "local" && SESSION_CLEAR_SIGNAL_STORAGE_KEY in changes) {
          listener(changes[SESSION_CLEAR_SIGNAL_STORAGE_KEY]?.newValue);
        }
      };
      chrome.storage.onChanged.addListener(onChanged);
      return () => chrome.storage.onChanged.removeListener(onChanged);
    },
  });
}
