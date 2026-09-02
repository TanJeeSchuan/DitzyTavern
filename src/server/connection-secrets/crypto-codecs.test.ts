import { describe, expect, test } from "bun:test";
import {
	decodeStrictBase64,
	encodeBase64,
	secureRandomBytes,
} from "./crypto-codecs";

describe("Crypto codecs", () => {
	test("generates random bytes of requested length", () => {
		const bytes16 = secureRandomBytes(16);
		const bytes32 = secureRandomBytes(32);
		expect(bytes16).toBeInstanceOf(Uint8Array);
		expect(bytes16.length).toBe(16);
		expect(bytes32.length).toBe(32);
	});

	test("round-trips binary data through canonical Base64 encoding and strict decoding", () => {
		const original = new Uint8Array([0, 1, 2, 253, 254, 255, 42, 127, 128]);
		const encoded = encodeBase64(original);
		const decoded = decodeStrictBase64(encoded);
		expect(decoded).toEqual(original);
	});

	test("rejects non-canonical Base64 strings with wrong length", () => {
		expect(() => decodeStrictBase64("abc")).toThrow("Invalid canonical Base64 encoding.");
		expect(() => decodeStrictBase64("abcde")).toThrow("Invalid canonical Base64 encoding.");
	});

	test("rejects Base64 strings with invalid characters", () => {
		expect(() => decodeStrictBase64("abcd!efg")).toThrow("Invalid canonical Base64 encoding.");
		expect(() => decodeStrictBase64("======")).toThrow("Invalid canonical Base64 encoding.");
	});

	test("rejects non-canonical padding bits", () => {
		// "ZE==" has non-zero unused bits, canonical is "ZA=="
		expect(() => decodeStrictBase64("ZE==")).toThrow("Invalid canonical Base64 encoding.");
	});

	test("uses custom error factory when provided", () => {
		class CustomError extends Error {}
		expect(() => decodeStrictBase64("invalid", () => new CustomError("custom error"))).toThrow(CustomError);
	});
});
