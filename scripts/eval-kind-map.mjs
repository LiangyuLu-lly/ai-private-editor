// Shared detector-kind → scored eval-label map. Kinds with no ml counterpart are
// dropped from scored predictions rather than guessed at.
export const KIND_TO_EVAL_LABEL = {
  phone: "CN_PHONE",
  email: "EMAIL",
  china_id: "CN_ID",
  bank_card: "BANK_CARD",
  person_name: "PERSON",
  address: "ADDRESS",
  account: "ACCOUNT_ALIAS",
  passport: "PASSPORT",
  license_plate: "LICENSE_PLATE",
};

export function splitByKind(findings) {
  const mapped = [];
  const droppedByKind = {};
  for (const finding of findings) {
    const label = KIND_TO_EVAL_LABEL[finding.kind];
    if (label === undefined) {
      const kind = finding.kind;
      droppedByKind[kind] = (droppedByKind[kind] ?? 0) + 1;
      continue;
    }
    mapped.push({ ...finding, label });
  }
  return { mapped, droppedByKind };
}
