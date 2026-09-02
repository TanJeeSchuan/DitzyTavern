import {
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import {
	decodeStrictBase64,
	encodeBase64,
	secureRandomBytes,
} from "./crypto-codecs";

export const CONNECTION_SECRET_KEY_ENV = "CONNECTION_SECRET_KEY";
export const CONNECTION_SECRET_KEY_BYTES = 32;

export type ConnectionSecretKeySource = "environment" | "env-file" | "generated";

export interface ConnectionSecretKeyBootstrapResult {
	readonly bytes: Uint8Array;
	readonly encoded: string;
	readonly source: ConnectionSecretKeySource;
}

export interface ConnectionSecretKeyBootstrapOptions {
	environment?: Readonly<Record<string, string | undefined>>;
	envFilePath?: string;
	randomBytes?: (length: number) => Uint8Array;
}

export class ConnectionSecretBootstrapError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConnectionSecretBootstrapError";
	}
}

interface EnvFileContents {
	contents: string;
	key?: string;
}

export function bootstrapConnectionSecretKey(
	options: ConnectionSecretKeyBootstrapOptions = {},
): ConnectionSecretKeyBootstrapResult {
	const environment = options.environment ?? process.env;
	const injected = environment[CONNECTION_SECRET_KEY_ENV];

	// ==[HUMAN APPROVED]== An injected value is authoritative. In particular, do not inspect or
	// modify the local .env file when deployment configuration supplied a key.
	if (injected !== undefined) {
		return createResult(decodeKey(injected, "injected configuration"), "environment");
	}

	const envFilePath = options.envFilePath ?? join(process.cwd(), ".env");
	const envFile = readEnvFile(envFilePath);
	if (envFile.key !== undefined) {
		return createResult(decodeKey(envFile.key, "local configuration"), "env-file");
	}

	const generated = options.randomBytes?.(CONNECTION_SECRET_KEY_BYTES) ??
		secureRandomBytes(CONNECTION_SECRET_KEY_BYTES);
	if (!(generated instanceof Uint8Array) || generated.length !== CONNECTION_SECRET_KEY_BYTES) {
		throw new ConnectionSecretBootstrapError(
			`Unable to bootstrap ${CONNECTION_SECRET_KEY_ENV}: key generation did not produce exactly ${CONNECTION_SECRET_KEY_BYTES} bytes.`,
		);
	}

	const bytes = new Uint8Array(generated);
	const encoded = encodeBase64(bytes);
	appendGeneratedKey(envFilePath, envFile.contents, encoded);
	return { bytes, encoded, source: "generated" };
}

export function decodeConnectionSecretKey(value: string): Uint8Array {
	const decoded = decodeStrictBase64(value, () =>
		new ConnectionSecretBootstrapError(
			`${CONNECTION_SECRET_KEY_ENV} must be canonical Base64.`,
		),
	);
	if (decoded.length !== CONNECTION_SECRET_KEY_BYTES) {
		throw new ConnectionSecretBootstrapError(
			`${CONNECTION_SECRET_KEY_ENV} must contain exactly ${CONNECTION_SECRET_KEY_BYTES} bytes encoded as Base64.`,
		);
	}
	return decoded;
}

const createResult = (
	bytes: Uint8Array,
	source: ConnectionSecretKeySource,
): ConnectionSecretKeyBootstrapResult => ({
	bytes: new Uint8Array(bytes),
	encoded: encodeBase64(bytes),
	source,
});

const readEnvFile = (path: string): EnvFileContents => {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		const code =
			error instanceof Error && "code" in error
				? error.code
				: undefined;
		if (code === "ENOENT") return { contents: "" };
		throw new ConnectionSecretBootstrapError(
			`Unable to bootstrap ${CONNECTION_SECRET_KEY_ENV}: cannot read the local configuration file.`,
		);
	}

	let key: string | undefined;
	for (const line of contents.split(/\r?\n/)) {
		const match = line.match(
			/^\s*(?:export\s+)?CONNECTION_SECRET_KEY\s*=(.*)$/,
		);
		if (!match) continue;
		if (key !== undefined) {
			throw new ConnectionSecretBootstrapError(
				`Unable to bootstrap ${CONNECTION_SECRET_KEY_ENV}: local configuration contains more than one key entry.`,
			);
		}
		key = unquoteEnvValue(match[1] ?? "");
	}

	return { contents, key };
};

const unquoteEnvValue = (value: string): string => {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
};

const appendGeneratedKey = (path: string, existing: string, encoded: string): void => {
	const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
	const entry = `${separator}${CONNECTION_SECRET_KEY_ENV}=${encoded}\n`;
	let fileDescriptor: number | undefined;
	try {
		fileDescriptor = openSync(path, "a");
		writeSync(fileDescriptor, entry, null, "utf8");
		fsyncSync(fileDescriptor);
	} catch {
		throw new ConnectionSecretBootstrapError(
			`Unable to bootstrap ${CONNECTION_SECRET_KEY_ENV}: the local configuration file could not be written durably.`,
		);
	} finally {
		if (fileDescriptor !== undefined) closeSync(fileDescriptor);
	}
};

const decodeKey = (value: string, source: string): Uint8Array => {
	try {
		return decodeConnectionSecretKey(value);
	} catch {
		throw new ConnectionSecretBootstrapError(
			`Invalid ${CONNECTION_SECRET_KEY_ENV} in ${source}: expected exactly ${CONNECTION_SECRET_KEY_BYTES} bytes encoded as Base64.`,
		);
	}
};
