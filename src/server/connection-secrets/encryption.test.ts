import { describe, expect, test } from "bun:test";
import {
	decryptConnectionSecretSync,
	encryptConnectionSecretSync,
	ConnectionSecretDecryptionError,
	CONNECTION_SECRET_FORMAT_VERSION,
} from ".";

const masterKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const payload = {
	credential: "sk-test-credential",
	headers: {
	"X-Workspace-Token": "header-secret",
	},
};

describe("Connection Secret authenticated encryption", () => {
	test("round-trips a payload with version, key identifier, nonce, ciphertext, and tag", () => {
		const encrypted = encryptConnectionSecretSync(masterKey, "profile-7", payload);

		expect(encrypted.formatVersion).toBe(CONNECTION_SECRET_FORMAT_VERSION);
		expect(encrypted.keyId).toMatch(/^[0-9a-f]+$/);
		expect(Buffer.from(encrypted.nonce, "base64")).toHaveLength(12);
		expect(Buffer.from(encrypted.tag, "base64")).toHaveLength(16);
		expect(Buffer.from(encrypted.ciphertext, "base64").length).toBeGreaterThan(0);
		expect(JSON.stringify(encrypted)).not.toContain(payload.credential);
		expect(JSON.stringify(encrypted)).not.toContain(payload.headers["X-Workspace-Token"]);

		expect(decryptConnectionSecretSync(masterKey, "profile-7", encrypted)).toEqual(payload);
	});

	test("uses a fresh nonce for each encryption", () => {
		const first = encryptConnectionSecretSync(masterKey, "profile-7", payload);
		const second = encryptConnectionSecretSync(masterKey, "profile-7", payload);

		expect(second.nonce).not.toBe(first.nonce);
		expect(second.ciphertext).not.toBe(first.ciphertext);
	});

	test("fails closed for a wrong key, modified ciphertext, modified tag, or swapped profile identity", () => {
		const encrypted = encryptConnectionSecretSync(masterKey, "profile-7", payload);
		const wrongKey = Uint8Array.from(masterKey, (byte) => byte ^ 0xff);

		expect(() => decryptConnectionSecretSync(wrongKey, "profile-7", encrypted))
			.toThrow(ConnectionSecretDecryptionError);
		expect(() => decryptConnectionSecretSync(masterKey, "profile-8", encrypted))
			.toThrow(ConnectionSecretDecryptionError);

		const modifiedCiphertext = {
			...encrypted,
			ciphertext: Buffer.from(
				Uint8Array.from(Buffer.from(encrypted.ciphertext, "base64"), (byte, index) =>
					index === 0 ? byte ^ 0xff : byte,
				),
			).toString("base64"),
		};
		expect(() => decryptConnectionSecretSync(masterKey, "profile-7", modifiedCiphertext))
			.toThrow(ConnectionSecretDecryptionError);

		const modifiedTag = {
			...encrypted,
			tag: Buffer.from(
				Uint8Array.from(Buffer.from(encrypted.tag, "base64"), (byte, index) =>
					index === 0 ? byte ^ 0xff : byte,
				),
			).toString("base64"),
		};
		expect(() => decryptConnectionSecretSync(masterKey, "profile-7", modifiedTag))
			.toThrow(ConnectionSecretDecryptionError);
	});
});
