import { defineRule, type ESTree } from "@oxlint/plugins";
import { memberName, unwrapExpression } from "../members.ts";
import { isTestFile, repositoryPath } from "../path.ts";

const topLevelHooks = new Set(["dependencies", "importSillyTavernNote", "read", "routes", "status", "upgrade"]);
const nestedHooks = ["moves.render", "records.fold", "records.foldAll", "advance.run", "advance.fingerprint", "digest.run", "delegate.apply"];
const guardOwners = new Set(["src/server/box/registry.ts", "src/server/box/sandboxed.ts"]);
const existingCalls = new Map<string, readonly string[]>([
	["src/server/authoring/scenario.ts", ["records.foldAll", "delegate.apply", "moves.render", "dependencies", "advance.run", "digest.run", "status"]], // Scenarios run already-checked hooks on their isolated Box runtime.
	["src/server/box/digest.ts", ["digest.run", "status"]], // The digest worker calls the checked registry hooks under the job's cancellation policy.
	["src/server/box/records.ts", ["records.fold", "records.foldAll"]], // The record reader folds through hooks already checked by the registry.
	["src/server/contract/box-window.ts", ["read"]], // The Box window runs the loaded hook with a checked snapshot.
	["src/server/conversation/box-values.ts", ["upgrade"]], // The stored-value upgrade seam guards the callback and validates its output.
	["src/server/sillytavern/import-projection.ts", ["importSillyTavernNote"]], // Imports call the checked registry hook to project an Author's Note.
]);

const boxReceiver = (expression: ESTree.Expression): boolean => {
	const node = unwrapExpression(expression);
	if (node.type === "Identifier") return node.name === "box" || node.name === "host" || node.name.endsWith("Box");
	return node.type === "MemberExpression" && memberName(node) === "box";
};

const hookPath = (expression: ESTree.Expression): string => {
	const node = unwrapExpression(expression);
	if (node.type === "Identifier") return node.name;
	if (node.type !== "MemberExpression") return "";
	const name = memberName(node);
	return name === undefined ? "" : `${hookPath(node.object)}.${name}`;
};

const boxHook = (node: ESTree.MemberExpression): string | undefined => {
	const name = memberName(node);
	if (name === "setupError") return name;
	if (name !== undefined && topLevelHooks.has(name) && boxReceiver(node.object)) return name;
	const receiver = unwrapExpression(node.object);
	if (receiver.type === "MemberExpression" && memberName(receiver) === "exports" && boxReceiver(receiver.object)) return "exports";
	const path = hookPath(node);
	return nestedHooks.find((hook) => path === hook || path.endsWith(`.${hook}`));
};

export const noUnguardedBoxHookRule = defineRule({
	meta: {
		type: "problem",
		messages: { unguarded: "Route the Box's {{ hook }} hook through its guarded host seam." },
	},
	create(context) {
		const path = repositoryPath(context.filename);
		if (!path.startsWith("src/server/") || isTestFile(path) || guardOwners.has(path)) return {};
		return {
			CallExpression(node) {
				const callee = unwrapExpression(node.callee);
				if (callee.type !== "MemberExpression") return;
				const hook = boxHook(callee);
				if (hook === undefined || existingCalls.get(path)?.includes(hook) ||
					(hook === "setupError" && path === "src/server/box/setup.ts")) return;
				context.report({ node, messageId: "unguarded", data: { hook } });
			},
		};
	},
});
