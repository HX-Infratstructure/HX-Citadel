import { afterEach, describe, expect, test, vi } from "vitest";
import { installRandomUuidFallback, randomUuidV4 } from "./random-uuid";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const fillRandom = (bytes: Uint8Array) => crypto.getRandomValues(bytes);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("randomUuidV4", () => {
  test("returns an RFC 4122 version 4 UUID", () => {
    expect(randomUuidV4(fillRandom)).toMatch(UUID_V4);
  });

  test.each([
    [0x00, "00000000-0000-4000-8000-000000000000"],
    [0xff, "ffffffff-ffff-4fff-bfff-ffffffffffff"],
  ])("sets the version and variant bits when every byte is %i", (byte, expected) => {
    expect(randomUuidV4((bytes) => bytes.fill(byte))).toBe(expected);
  });

  test("1000 calls give no duplicates", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => randomUuidV4(fillRandom)));
    expect(ids.size).toBe(1000);
  });
});

describe("installRandomUuidFallback", () => {
  test("installs a working randomUUID on the global crypto, called on that crypto", () => {
    const insecureCrypto: { getRandomValues(bytes: Uint8Array): Uint8Array; randomUUID?: () => string } = {
      getRandomValues(bytes) {
        if (this !== insecureCrypto) throw new TypeError("Illegal invocation");
        return bytes.fill(0x07);
      },
    };
    vi.stubGlobal("crypto", insecureCrypto);
    installRandomUuidFallback();
    expect(insecureCrypto.randomUUID?.()).toBe("07070707-0707-4707-8707-070707070707");
  });

  test("leaves a native randomUUID unchanged", () => {
    const nativeRandomUuid = () => "native";
    const secureCrypto = { getRandomValues: fillRandom, randomUUID: nativeRandomUuid };
    installRandomUuidFallback(secureCrypto);
    expect(secureCrypto.randomUUID).toBe(nativeRandomUuid);
  });

  test("does nothing when there is no crypto", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => installRandomUuidFallback()).not.toThrow();
    expect(globalThis.crypto).toBeUndefined();
  });

  test("does nothing on a crypto without getRandomValues", () => {
    const partialCrypto: { randomUUID?: () => string } = {};
    installRandomUuidFallback(partialCrypto);
    expect(partialCrypto.randomUUID).toBeUndefined();
  });
});
