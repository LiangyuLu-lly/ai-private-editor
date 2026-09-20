import { chatgptAdapter } from "./chatgpt.js";
import { claudeAdapter } from "./claude.js";
import { deepseekAdapter } from "./deepseek.js";
import { doubaoAdapter } from "./doubao.js";
import { geminiAdapter } from "./gemini.js";
import { kimiAdapter } from "./kimi.js";
import { qwenAdapter } from "./qwen.js";
import { wenxinAdapter } from "./wenxin.js";
import { yuanbaoAdapter } from "./yuanbao.js";
import type { SiteAdapter } from "./types.js";

const SITE_ADAPTERS: readonly SiteAdapter[] = [
  doubaoAdapter,
  deepseekAdapter,
  yuanbaoAdapter,
  chatgptAdapter,
  claudeAdapter,
  geminiAdapter,
  kimiAdapter,
  qwenAdapter,
  wenxinAdapter,
];

export function getRegisteredSiteAdapters(): readonly SiteAdapter[] {
  return SITE_ADAPTERS;
}

export function getSiteAdapter(url: URL): SiteAdapter | null {
  return SITE_ADAPTERS.find((adapter) => adapter.matches(url)) ?? null;
}
