import {
	bootstrapConnectionSecretKey,
	ConnectionSecretBootstrapError,
} from "./bootstrap";
import type {
	ConnectionSecretKeyBootstrapOptions,
	ConnectionSecretKeyBootstrapResult,
} from "./bootstrap";

let applicationKey: Uint8Array | undefined;

export function initializeConnectionSecretKey(
	options: ConnectionSecretKeyBootstrapOptions = {},
): ConnectionSecretKeyBootstrapResult {
	const result = bootstrapConnectionSecretKey(options);
	applicationKey = new Uint8Array(result.bytes);
	return {
		...result,
		bytes: new Uint8Array(result.bytes),
	};
}

export function getConnectionSecretKey(): Uint8Array {
	if (!applicationKey) {
		throw new ConnectionSecretBootstrapError(
			"Connection Secret master key has not been initialized.",
		);
	}
	return new Uint8Array(applicationKey);
}

export {
	bootstrapConnectionSecretKey,
	ConnectionSecretBootstrapError,
	decodeConnectionSecretKey,
	CONNECTION_SECRET_KEY_BYTES,
	CONNECTION_SECRET_KEY_ENV,
} from "./bootstrap";
export {
	decryptConnectionSecret,
	decryptConnectionSecretSync,
	encryptConnectionSecret,
	encryptConnectionSecretSync,
	ConnectionSecretDecryptionError,
	ConnectionSecretEncryptionError,
	CONNECTION_SECRET_FORMAT_VERSION,
	CONNECTION_SECRET_NONCE_BYTES,
	CONNECTION_SECRET_TAG_BYTES,
} from "./encryption";
export type {
	ConnectionSecretKeyBootstrapOptions,
	ConnectionSecretKeyBootstrapResult,
	ConnectionSecretKeySource,
} from "./bootstrap";
export type {
	ConnectionSecretPayload,
	EncryptedConnectionSecret,
	EncryptConnectionSecretOptions,
} from "./encryption";
