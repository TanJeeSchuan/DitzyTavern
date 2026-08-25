import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONNECTION_SECRET_KEY_ENV,
	bootstrapConnectionSecretKey,
	ConnectionSecretBootstrapError,
} from ".";

const generatedKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

describe("Connection Secret master-key bootstrap", () => {
	let directories: string[] = [];

	afterEach(() => {
		for (const directory of directories) {
			rmSync(directory, { recursive: true, force: true });
		}
		directories = [];
	});

	const temporaryDirectory = () => {
		const directory = mkdtempSync(join(tmpdir(), "ditzytavern-secret-bootstrap-"));
		directories.push(directory);
		return directory;
	};

	test("uses an explicitly injected valid key without writing local configuration", () => {
		const directory = temporaryDirectory();
		const envFilePath = join(directory, ".env");
		const encoded = Buffer.from(generatedKey).toString("base64");
		let randomCalls = 0;

		const result = bootstrapConnectionSecretKey({
			environment: { [CONNECTION_SECRET_KEY_ENV]: encoded },
			envFilePath,
			randomBytes: () => {
				randomCalls += 1;
			return generatedKey;
		},
		});

		expect(result.source).toBe("environment");
		expect(result.encoded).toBe(encoded);
		expect(result.bytes).toEqual(generatedKey);
		expect(randomCalls).toBe(0);
		expect(() => readFileSync(envFilePath)).toThrow();
	});

	test("rejects a malformed injected value without echoing key material", () => {
		const secretLikeValue = "not-a-valid-master-key";

		expect(() =>
			bootstrapConnectionSecretKey({
				environment: { [CONNECTION_SECRET_KEY_ENV]: secretLikeValue },
			}),
		).toThrow(ConnectionSecretBootstrapError);

		try {
			bootstrapConnectionSecretKey({
				environment: { [CONNECTION_SECRET_KEY_ENV]: secretLikeValue },
			});
		} catch (error) {
			if (!(error instanceof ConnectionSecretBootstrapError)) throw error;
			expect(error.message).toContain(CONNECTION_SECRET_KEY_ENV);
			expect(error.message).not.toContain(secretLikeValue);
		}
	});

	test("rejects a canonical Base64 value with the wrong decoded length", () => {
		const wrongLength = Buffer.from(generatedKey.slice(0, 31)).toString("base64");

		expect(() =>
			bootstrapConnectionSecretKey({
				environment: { [CONNECTION_SECRET_KEY_ENV]: wrongLength },
			}),
		).toThrow(/exactly 32 bytes/);
	});

	test("generates a missing key, preserves .env content, and appends one entry", () => {
		const directory = temporaryDirectory();
		const envFilePath = join(directory, ".env");
		const existing = "APP_MODE=local\n\n# Keep this comment\n";
		writeFileSync(envFilePath, existing, "utf8");

		const result = bootstrapConnectionSecretKey({
			environment: {},
			envFilePath,
			randomBytes: (length) => {
				expect(length).toBe(32);
				return generatedKey;
			},
		});

		const contents = readFileSync(envFilePath, "utf8");
		expect(result.source).toBe("generated");
		expect(result.bytes).toEqual(generatedKey);
		expect(contents.startsWith(existing)).toBe(true);
		expect(
			contents
				.split(/\r?\n/)
				.filter((line) => line.startsWith(`${CONNECTION_SECRET_KEY_ENV}=`)),
		).toEqual([`${CONNECTION_SECRET_KEY_ENV}=${result.encoded}`]);
	});

	test("uses a valid key already present in .env without duplicating it", () => {
		const directory = temporaryDirectory();
		const envFilePath = join(directory, ".env");
		const encoded = Buffer.from(generatedKey).toString("base64");
		writeFileSync(
			envFilePath,
			`APP_MODE=local\n${CONNECTION_SECRET_KEY_ENV}=${encoded}\n`,
			"utf8",
		);

		const result = bootstrapConnectionSecretKey({
			environment: {},
			envFilePath,
			randomBytes: () => {
				throw new Error("generation should not be needed");
			},
		});

		expect(result.source).toBe("env-file");
		expect(result.encoded).toBe(encoded);
		expect(readFileSync(envFilePath, "utf8")).toBe(
			`APP_MODE=local\n${CONNECTION_SECRET_KEY_ENV}=${encoded}\n`,
		);
	});

	test("fails fast when the generated key cannot be durably written", () => {
		const directory = temporaryDirectory();
		const envFilePath = join(directory, "missing-parent", ".env");

		expect(() =>
			bootstrapConnectionSecretKey({
				environment: {},
				envFilePath,
				randomBytes: () => generatedKey,
			}),
		).toThrow(ConnectionSecretBootstrapError);
	});
});
