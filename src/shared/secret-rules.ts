export type CuratedSecretRule = {
  id: string;
  pattern: RegExp;
  keywords?: readonly string[];
};

const CURATED_SECRET_RULES: readonly CuratedSecretRule[] = [
  {
    id: "gitlab-pat",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    id: "npm-token",
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g,
  },
  {
    id: "stripe-secret",
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    id: "huggingface-token",
    pattern: /\bhf_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: "azure-storage-key-assignment",
    pattern: /\b(?:AccountKey|azure_storage_key)\s*[=:]\s*[A-Za-z0-9+/]{32,}={0,2}/gi,
  },
  {
    id: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/gi,
    keywords: ["bearer"],
  },
  {
    id: "aws-secret-access-key",
    pattern: /\b(?=[A-Za-z0-9+/]{40}\b)[A-Za-z0-9+/]*[/+][A-Za-z0-9+/=]*\b/g,
  },
  {
    id: "azure-sas-signature",
    pattern: /[?&]sig=[A-Za-z0-9%+/=_-]{20,}/gi,
  },
  {
    id: "openai-svcacct",
    pattern: /\bsk-svcacct-[A-Za-z0-9_-]{20,}\b/g,
  },
];

export function getCuratedSecretRules(): readonly CuratedSecretRule[] {
  return CURATED_SECRET_RULES;
}
