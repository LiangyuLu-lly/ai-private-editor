import { describe, expect, it } from "vitest";

import {
  isIpv4Address,
  isValidUnifiedSocialCreditCode,
  isValidChinaResidentId,
  passesLuhnCheck,
} from "../src/shared/validators.js";

describe("sensitive value validators", () => {
  it("validates an 18-digit mainland China resident ID checksum and date", () => {
    expect(isValidChinaResidentId("11010519491231002X")).toBe(true);
    expect(isValidChinaResidentId("11010519490230002X")).toBe(false);
    expect(isValidChinaResidentId("110105194912310021")).toBe(false);
  });

  it("accepts only Luhn-valid card-like numbers", () => {
    expect(passesLuhnCheck("4539 1488 0343 6467")).toBe(true);
    expect(passesLuhnCheck("4539 1488 0343 6468")).toBe(false);
    expect(passesLuhnCheck("1234 5678")).toBe(false);
  });

  it("validates a unified social credit code checksum and rejects a wrong check character", () => {
    expect(isValidUnifiedSocialCreditCode("91110108MA01K12342")).toBe(true);
    expect(isValidUnifiedSocialCreditCode("91110108MA01K12343")).toBe(false);
    expect(isValidUnifiedSocialCreditCode("91110108MA01I12342")).toBe(false);
  });

  it("accepts only IPv4 octets in range", () => {
    expect(isIpv4Address("192.168.1.1")).toBe(true);
    expect(isIpv4Address("256.168.1.1")).toBe(false);
    expect(isIpv4Address("192.168.1")).toBe(false);
  });
});
