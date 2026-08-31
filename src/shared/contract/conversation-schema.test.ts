import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";
import {
	ARCHIVE_NAMESPACE,
	IMPORT_NAMESPACE,
} from "../import-data";
import { conversationCommandBody } from "./conversation-schema";

// The generic data commands carry the import-owned namespace reservation:
// ordinary namespaces validate as before, and the namespaces that own
// Import provenance never do (ADR-0028). The Conversation seam enforces the
// same reservation; this pins it at the wire contract.
describe("generic data command namespaces", () => {
	const putData = (namespace: string) => ({
		expectedRevision: 0,
		action: {
			type: "put-data",
			scope: { type: "conversation" },
			namespace,
			key: "key",
			value: "value",
		},
	});
	const deleteData = (namespace: string) => ({
		expectedRevision: 0,
		action: {
			type: "delete-data",
			scope: { type: "conversation" },
			namespace,
			key: "key",
		},
	});

	test("ordinary generic namespaces validate", () => {
		expect(Value.Check(conversationCommandBody, putData("notes"))).toBe(true);
		expect(
			Value.Check(conversationCommandBody, deleteData("notes")),
		).toBe(true);
	});

	// The reservation is exact-match, not prefix-based: strings that merely
	// contain or extend an import-owned namespace stay generic.
	test("near-miss generic namespaces validate", () => {
		expect(
			Value.Check(conversationCommandBody, putData("import.sillytavernX")),
		).toBe(true);
		expect(Value.Check(conversationCommandBody, putData("archiveX"))).toBe(
			true,
		);
	});

	test("import-owned namespaces are not addressable", () => {
		expect(
			Value.Check(conversationCommandBody, putData(IMPORT_NAMESPACE)),
		).toBe(false);
		expect(
			Value.Check(conversationCommandBody, putData(ARCHIVE_NAMESPACE)),
		).toBe(false);
		expect(
			Value.Check(conversationCommandBody, deleteData(IMPORT_NAMESPACE)),
		).toBe(false);
		expect(
			Value.Check(conversationCommandBody, deleteData(ARCHIVE_NAMESPACE)),
		).toBe(false);
	});
});
