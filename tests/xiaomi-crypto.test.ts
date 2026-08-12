import { describe, expect, test } from "bun:test";
import { buildEncryptedParams, computeSignedNonce, decryptData, encryptData } from "../src/xiaomi/client.js";

describe("Xiaomi crypto", () => {
  test("round-trips encrypted payloads and request params", () => {
    const ssecurity = Buffer.from("test-ssecurity-key").toString("base64");
    const nonce = Buffer.from("123456789012").toString("base64");
    const signed = computeSignedNonce(ssecurity, nonce);
    expect(decryptData(signed, encryptData(signed, '{"中文":"тест"}'))).toBe('{"中文":"тест"}');
    const params = buildEncryptedParams("POST", "/test", ssecurity, { test: "hello", num: 42 });
    expect(JSON.parse(decryptData(computeSignedNonce(ssecurity, params._nonce ?? ""), params.data ?? ""))).toEqual({
      test: "hello",
      num: 42,
    });
    expect(params.signature).toBeString();
    expect(params.rc4_hash__).toBeString();
  });
});
