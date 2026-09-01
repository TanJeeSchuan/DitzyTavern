import { Buffer } from "node:buffer";
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes as cryptoRandomBytes,
} from "node:crypto";

export const CONNECTION_SECRET_FORMAT_VERSION = 1 as const;
export const CONNECTION_SECRET_NONCE_BYTES = 12;
export const CONNECTION_SECRET_TAG_BYTES = 16;
const CONNECTION_SECRET_KEY_BYTES = 32;

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
	[key: string]: JsonValue;
}

export interface ConnectionSecretPayload extends JsonObject {
	credential: string | null;
	headers: Record<string, string>;
}

export interface EncryptedConnectionSecret {
	formatVersion: typeof CONNECTION_SECRET_FORMAT_VERSION;
	keyId: string;
	nonce: string;
	ciphertext: string;
	tag: string;
}

export interface EncryptConnectionSecretOptions {
	randomBytes?: (length: number) => Uint8Array;
}

export class ConnectionSecretEncryptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConnectionSecretEncryptionError";
	}
}

export class ConnectionSecretDecryptionError extends Error {
	constructor(message = "Unable to decrypt the Connection Secret.") {
		super(message);
		this.name = "ConnectionSecretDecryptionError";
	}
}

export function encryptConnectionSecretSync(
	masterKey: Uint8Array,
	profileId: string | number,
	payload: ConnectionSecretPayload,
	options: EncryptConnectionSecretOptions = {},
): EncryptedConnectionSecret {
	assertMasterKey(masterKey);
	assertPayload(payload);

	const keyId = deriveKeyId(masterKey);
	const nonce = options.randomBytes?.(CONNECTION_SECRET_NONCE_BYTES) ??
		secureRandomBytes(CONNECTION_SECRET_NONCE_BYTES);
	if (!(nonce instanceof Uint8Array) || nonce.length !== CONNECTION_SECRET_NONCE_BYTES) {
		throw new ConnectionSecretEncryptionError(
			"Connection Secret encryption did not produce a valid nonce.",
		);
	}

	try {
		const cipher = createCipheriv(
			"aes-256-gcm",
			Buffer.from(masterKey),
			Buffer.from(nonce),
			{ authTagLength: CONNECTION_SECRET_TAG_BYTES },
		);
		cipher.setAAD(Buffer.from(associatedData(profileId, keyId)));
		const ciphertext = Buffer.concat([
			cipher.update(JSON.stringify(payload), "utf8"),
			cipher.final(),
		]);
		return {
			formatVersion: CONNECTION_SECRET_FORMAT_VERSION,
			keyId,
			nonce: encodeBase64(nonce),
			ciphertext: encodeBase64(ciphertext),
			tag: encodeBase64(cipher.getAuthTag()),
		};
	} catch {
		throw new ConnectionSecretEncryptionError(
			"Unable to encrypt the Connection Secret.",
		);
	}
}

export function decryptConnectionSecretSync(
	masterKey: Uint8Array,
	profileId: string | number,
	encrypted: EncryptedConnectionSecret,
): ConnectionSecretPayload {
	try {
		assertMasterKey(masterKey);
		assertEncryptedSecret(encrypted);

		const keyId = deriveKeyId(masterKey);
		if (encrypted.keyId !== keyId) throw new ConnectionSecretDecryptionError();

		const nonce = decodeBase64(encrypted.nonce);
		const ciphertext = decodeBase64(encrypted.ciphertext);
		const tag = decodeBase64(encrypted.tag);
		if (
			nonce.length !== CONNECTION_SECRET_NONCE_BYTES ||
			tag.length !== CONNECTION_SECRET_TAG_BYTES
		) {
			throw new ConnectionSecretDecryptionError();
		}

		const decipher = createDecipheriv(
			"aes-256-gcm",
			Buffer.from(masterKey),
			Buffer.from(nonce),
			{ authTagLength: CONNECTION_SECRET_TAG_BYTES },
		);
		decipher.setAAD(Buffer.from(associatedData(profileId, keyId)));
		decipher.setAuthTag(Buffer.from(tag));
		const plaintext = Buffer.concat([
			decipher.update(Buffer.from(ciphertext)),
			decipher.final(),
		]);
		const parsed: JsonValue = JSON.parse(plaintext.toString("utf8"));
		if (!isConnectionSecretPayload(parsed)) {
			throw new ConnectionSecretDecryptionError();
		}
		return parsed;
	} catch (error) {
		if (error instanceof ConnectionSecretDecryptionError) throw error;
		throw new ConnectionSecretDecryptionError();
	}
}

const assertMasterKey = (masterKey: Uint8Array): void => {
	if (masterKey.length !== CONNECTION_SECRET_KEY_BYTES) {
		throw new ConnectionSecretEncryptionError(
			`Connection Secret master key must be exactly ${CONNECTION_SECRET_KEY_BYTES} bytes.`,
		);
	}
};

const assertPayload = (payload: ConnectionSecretPayload): void => {
	if (!isConnectionSecretPayload(payload)) {
		throw new ConnectionSecretEncryptionError(
			"Connection Secret payload has an invalid shape.",
		);
	}
};

const isJsonObject = (value: JsonValue): value is JsonObject =>
	Object.prototype.toString.call(value) === "[object Object]";

const isConnectionSecretPayload = (
	value: JsonValue,
): value is ConnectionSecretPayload => {
	if (!isJsonObject(value)) return false;
	if (value.credential !== null && !isJsonString(value.credential)) return false;
	if (!isJsonObject(value.headers)) return false;
	return Object.values(value.headers).every((header) => isJsonString(header));
};

const isJsonString = (value: JsonValue): value is string =>
	Object.prototype.toString.call(value) === "[object String]";

const secureRandomBytes = (length: number): Uint8Array => {
	return new Uint8Array(cryptoRandomBytes(length));
};

const deriveKeyId = (masterKey: Uint8Array): string => {
	return createHash("sha256").update(masterKey).digest("hex");
};

const associatedData = (profileId: string | number, keyId: string): Uint8Array =>
	new TextEncoder().encode(
		`DitzyTavern/ConnectionSecret/${CONNECTION_SECRET_FORMAT_VERSION}/${String(profileId)}/${keyId}`,
	);

const encodeBase64 = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString("base64");

const decodeBase64 = (value: string): Uint8Array => {
	if (
		value.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
	) {
		throw new ConnectionSecretDecryptionError();
	}
	const decoded = Buffer.from(value, "base64");
	if (encodeBase64(decoded) !== value) throw new ConnectionSecretDecryptionError();
	return new Uint8Array(decoded);
};

const assertEncryptedSecret = (
	encrypted: EncryptedConnectionSecret,
): void => {
	if (encrypted.formatVersion !== CONNECTION_SECRET_FORMAT_VERSION) {
		throw new ConnectionSecretDecryptionError();
	}
};
