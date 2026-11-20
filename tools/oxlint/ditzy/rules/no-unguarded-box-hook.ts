import { defineRule, type ESTree } from "@oxlint/plugins";
import { memberName, unwrapExpression } from "../members.ts";
import { isTestFile, repositoryPath } from "../path.ts";

const hooks = new Set([
	"setupError", "dependencies", "exports", "importSillyTavernNote", "read", "routes", "status", "upgrade",
	"moves.render", "records.fold", "records.foldAll", "advance.run", "advance.fingerprint", "records.digest.run", "delegate.apply",
]);
const guardOwners = new Set(["src/server/box/registry.ts", "src/server/box/sandboxed.ts"]);
const existingCalls = new Map<string, readonly string[]>([
	["src/server/authoring/scenario.ts", ["records.foldAll", "delegate.apply", "moves.render", "dependencies", "advance.run", "status"]], // Scenarios run already-checked hooks on their isolated Box runtime.
	["src/server/box/digest.ts", ["status"]], // The digest worker calls the checked registry hooks under the job's cancellation policy.
	["src/server/contract/box-window.ts", ["read"]], // The Box window runs the loaded hook with a checked snapshot.
	["src/server/conversation/box-values.ts", ["upgrade"]], // The stored-value upgrade seam guards the callback and validates its output.
	["src/server/sillytavern/import-projection.ts", ["importSillyTavernNote"]], // Imports call the checked registry hook to project an Author's Note.
]);

const boxReceiver = (expression: ESTree.Expression): boolean => {
	const node = unwrapExpression(expression);
	if (node.type === "Identifier") return node.name === "box" || node.name === "host" || node.name.endsWith("Box");
	return node.type === "MemberExpression" && memberName(node) === "box";
};

const boxMemberPath = (expression: ESTree.Expression): string | undefined => {
	const node = unwrapExpression(expression);
	if (boxReceiver(node)) return "";
	if (node.type !== "MemberExpression") return undefined;
	const prefix = boxMemberPath(node.object);
	const name = memberName(node);
	if (prefix === undefined || name === undefined) return undefined;
	return prefix === "" ? name : `${prefix}.${name}`;
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
				const hook = boxMemberPath(callee.object) === "exports" ? "exports" : boxMemberPath(callee);
				if (hook === undefined || !hooks.has(hook) || existingCalls.get(path)?.includes(hook) ||
					(hook === "setupError" && path === "src/server/box/setup.ts")) return;
				context.report({ node, messageId: "unguarded", data: { hook } });
			},
		};
	},
});
