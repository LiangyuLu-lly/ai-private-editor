export const KIND_TO_EVAL_LABEL: {
  readonly phone: "CN_PHONE";
  readonly email: "EMAIL";
  readonly china_id: "CN_ID";
  readonly bank_card: "BANK_CARD";
  readonly person_name: "PERSON";
  readonly address: "ADDRESS";
  readonly account: "ACCOUNT_ALIAS";
  readonly passport: "PASSPORT";
  readonly license_plate: "LICENSE_PLATE";
};

export function splitByKind(findings: readonly { readonly kind: string }[]): {
  readonly mapped: ReadonlyArray<{ readonly kind: string; readonly label: string }>;
  readonly droppedByKind: Readonly<Record<string, number>>;
};
