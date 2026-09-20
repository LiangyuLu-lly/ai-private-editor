import { describe, expect, it } from "vitest";

import { KIND_TO_EVAL_LABEL, splitByKind } from "../scripts/eval-kind-map.mjs";

describe("eval kind map", () => {
  it("counts dropped ipv4 and still maps passport and license_plate", () => {
    // Given: mixed detector kinds, only 9 of which are scored
    const findings = [
      { kind: "ipv4" },
      { kind: "passport" },
      { kind: "license_plate" },
      { kind: "phone" },
    ];

    // When
    const { mapped, droppedByKind } = splitByKind(findings);

    // Then: scored labels stay in the 9-label set; ipv4 is counted, not scored
    expect(mapped.map((item: { readonly label: string }) => item.label)).toEqual([
      "PASSPORT",
      "LICENSE_PLATE",
      "CN_PHONE",
    ]);
    expect(droppedByKind).toEqual({ ipv4: 1 });
    expect(KIND_TO_EVAL_LABEL).toEqual({
      phone: "CN_PHONE",
      email: "EMAIL",
      china_id: "CN_ID",
      bank_card: "BANK_CARD",
      person_name: "PERSON",
      address: "ADDRESS",
      account: "ACCOUNT_ALIAS",
      passport: "PASSPORT",
      license_plate: "LICENSE_PLATE",
    });
  });
});
