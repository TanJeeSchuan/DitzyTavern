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
	CONNECTION_SECRET_KEY_ENV,
} from "./bootstrap";
export {
	decryptConnectionSecretSync,
	encryptConnectionSecretSync,
	ConnectionSecretDecryptionError,
	CONNECTION_SECRET_FORMAT_VERSION,
} from "./encryption";
