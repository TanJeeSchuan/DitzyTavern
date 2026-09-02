import { Buffer } from "node:buffer";
import { randomBytes as cryptoRandomBytes } from "node:crypto";

export const secureRandomBytes = (length: number): Uint8Array => {
	return new Uint8Array(cryptoRandomBytes(length));
};

export const encodeBase64 = (bytes: Uint8Array): string => {
	return Buffer.from(bytes).toString("base64");
};

export const decodeStrictBase64 = (
	value: string,
	onError?: () => Error,
): Uint8Array => {
	if (
		value.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
	) {
		throw onError ? onError() : new Error("Invalid canonical Base64 encoding.");
	}

	const decoded = Buffer.from(value, "base64");
	if (encodeBase64(decoded) !== value) {
		throw onError ? onError() : new Error("Invalid canonical Base64 encoding.");
	}

	return new Uint8Array(decoded);
};
