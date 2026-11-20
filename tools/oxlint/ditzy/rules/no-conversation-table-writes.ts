import { defineRule, type ESTree, type SourceCode } from "@oxlint/plugins";
import { moduleExportName } from "../imports.ts";
import { memberName, unwrapExpression } from "../members.ts";
import { importTarget, isTestFile, repositoryPath } from "../path.ts";
import { referenceOf } from "../scope.ts";

const conversationTables = new Set([
	"activeGenerationTable", "artifactTable", "conversationControlTable", "conversationDataTable",
	"conversationGenerationSettingsTable", "conversationLoreSettingsTable", "conversationLorebookAttachmentTable",
	"conversationPromptPresetTable", "conversationTable", "generationCaptureTable", "generationCheckpointTable",
	"generationReplayTable", "messageDataTable", "messageTable", "messageVariantDataTable", "messageVariantTable",
	"participantDataTable", "participantLorebookAttachmentTable", "participantOpeningTable", "participantPromptTable",
	"participantTable",
]);
const mutations = new Set(["insert", "update", "delete"]);
const existingWrites = new Map<string, readonly string[]>([
	["src/server/box/moves.ts", ["delete messageDataTable", "insert messageDataTable"]], // The Move store is called from Conversation commands.
	["src/server/box/records.ts", ["delete messageVariantDataTable", "insert messageVariantDataTable"]], // The Box record store serves commands and background digest completion.
	["src/server/box/stored-value.ts", ["insert participantDataTable", "insert conversationDataTable"]], // SDK stores enforce the Box namespace and own guarded value writes.
	["src/server/box/version-pin.ts", ["insert conversationDataTable"]], // The version store persists each Chat's pins for Box command and install flows.
	["src/server/connection-settings/index.ts", ["update conversationGenerationSettingsTable"]], // Profile creation fills empty Chat defaults in the profile transaction.
	["src/server/database/teardown.ts", ["delete conversationTable"]], // Dev teardown matches and removes only seeded Chats.
	["src/server/painting/index.ts", ["insert conversationDataTable", "delete conversationDataTable", "insert messageVariantDataTable", "delete messageVariantDataTable"]], // Paint owns existing gallery, aspect ratio and Illustration storage.
	["src/server/prompt-preset/library.ts", ["update conversationPromptPresetTable"]], // Library deletion reassigns affected selections inside the preset deletion transaction.
	["src/server/prompt-preset/recipe.ts", ["insert conversationPromptPresetTable", "update conversationPromptPresetTable"]], // Existing helpers use the Chat command's transaction.
]);

const schemaBinding = (source: SourceCode, path: string, identifier: ESTree.IdentifierReference) => {
	const definition = referenceOf(source, identifier)?.resolved?.defs[0];
	return definition?.type === "ImportBinding" && definition.parent?.type === "ImportDeclaration" &&
		importTarget(path, definition.parent.source.value) === "src/server/database/schema" ? definition.node : undefined;
};

const schemaTable = (source: SourceCode, path: string, argument: ESTree.Expression): string | undefined => {
	const node = unwrapExpression(argument);
	if (node.type === "Identifier") {
		const binding = schemaBinding(source, path, node);
		return binding?.type === "ImportSpecifier" ? moduleExportName(binding.imported) : undefined;
	}
	if (node.type === "MemberExpression") {
		const namespace = unwrapExpression(node.object);
		if (namespace.type === "Identifier" && schemaBinding(source, path, namespace)?.type === "ImportNamespaceSpecifier") return memberName(node);
	}
	return undefined;
};

const collectionConstructors = new Set(["Map", "Set", "WeakMap", "WeakSet"]);
const nativeCollection = (source: SourceCode, identifier: ESTree.IdentifierReference): boolean =>
	collectionConstructors.has(identifier.name) && !referenceOf(source, identifier)?.resolved?.defs.length;

function createsCollection(source: SourceCode, expression: ESTree.Expression): boolean {
	const value = unwrapExpression(expression);
	if (value.type === "NewExpression" && value.callee.type === "Identifier") return nativeCollection(source, value.callee);
	if (value.type !== "CallExpression" || value.callee.type !== "MemberExpression") return false;
	const factory = value.callee;
	return factory.object.type === "Identifier" && factory.object.name === "Map" && nativeCollection(source, factory.object) && memberName(factory) === "groupBy";
}

function isCollection(source: SourceCode, expression: ESTree.Expression): boolean {
	const receiver = unwrapExpression(expression);
	const variable = receiver.type === "Identifier" ? referenceOf(source, receiver)?.resolved : undefined;
	if (variable == null) return createsCollection(source, receiver);
	const binding = variable.defs[0];
	const annotation = binding?.name.type === "Identifier" ? binding.name.typeAnnotation?.typeAnnotation : undefined;
	if (annotation?.type === "TSTypeReference" && annotation.typeName.type === "Identifier" && nativeCollection(source, annotation.typeName)) return true;

	const node = binding?.node;
	const init = node?.type === "VariableDeclarator" ? node.init : undefined;
	const values = variable.references.filter((reference) => reference.isWrite() && !reference.init).map((reference) => reference.writeExpr);
	if (init != null) values.push(init);
	return values.length > 0 && values.every((value) => value !== null && createsCollection(source, value));
}

export const noConversationTableWritesRule = defineRule({
	meta: {
		type: "problem",
		messages: { directWrite: "Write {{ table }} through a Conversation command." },
	},
	create(context) {
		const path = repositoryPath(context.filename);
		if (path.startsWith("src/server/conversation/") || isTestFile(path)) return {};
		return {
			CallExpression(node) {
				const callee = unwrapExpression(node.callee);
				if (callee.type !== "MemberExpression") return;
				const method = memberName(callee);
				const argument = node.arguments[0];
				if (method === undefined || !mutations.has(method) || argument === undefined || argument.type === "SpreadElement") return;
				const table = schemaTable(context.sourceCode, path, argument);
				if (table === undefined || !conversationTables.has(table) || existingWrites.get(path)?.includes(`${method} ${table}`) ||
					(method === "delete" && isCollection(context.sourceCode, callee.object))) return;
				context.report({ node, messageId: "directWrite", data: { table } });
			},
		};
	},
});
