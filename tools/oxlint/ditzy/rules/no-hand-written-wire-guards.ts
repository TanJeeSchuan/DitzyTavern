import { defineRule, type ESTree } from "@oxlint/plugins";

import { repositoryPath } from "../path.ts";

const isMigratedTransport = (filename: string): boolean => {
	const path = repositoryPath(filename);
	return path === "src/client/chat-history.ts" ||
		path.includes("/transport/") ||
		/[-.]transport\.[cm]?[jt]sx?$/.test(path);
};

const containingFunction = (node: ESTree.Node): ESTree.Node | null => {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (
			current.type === "FunctionDeclaration" ||
			current.type === "FunctionExpression" ||
			current.type === "ArrowFunctionExpression"
		) return current;
		current = current.parent;
	}
	return null;
};

const rootIdentifier = (node: ESTree.Node): string | null => {
	let current = node;
	while (current.type === "MemberExpression") current = current.object;
	return current.type === "Identifier" ? current.name : null;
};

interface FunctionGuards {
	readonly node: ESTree.Node;
	readonly propertyReadRoots: Set<string>;
	readonly rowGuardRoots: Set<string>;
}

/** Reject property-by-property payload decoders in migrated transport modules. */
export const noHandWrittenWireGuardsRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Use canonical TypeBox schemas to decode migrated client transports.",
		},
		messages: {
			handWrittenGuard:
				"Decode this wire payload with Value.Decode and a schema from src/shared/contract, or call the shared schema-based decode helper. Property-by-property guards duplicate the wire contract.",
		},
	},
	createOnce(context) {
		const functions = new Map<ESTree.Node, FunctionGuards>();
		const functionState = (node: ESTree.Node): FunctionGuards | null => {
			const owner = containingFunction(node);
			if (owner === null) return null;
			const existing = functions.get(owner);
			if (existing !== undefined) return existing;
			const created = {
				node: owner,
				propertyReadRoots: new Set<string>(),
				rowGuardRoots: new Set<string>(),
			};
			functions.set(owner, created);
			return created;
		};

		return {
			before() {
				functions.clear();
			},
			CallExpression(node) {
				if (!isMigratedTransport(context.filename)) return;
				if (
					node.callee.type !== "Identifier" ||
					node.callee.name !== "isRow"
				) return;
				const state = functionState(node);
				const argument = node.arguments[0];
				if (state === null || argument === undefined || argument.type === "SpreadElement") return;
				if (argument.type === "Identifier") state.rowGuardRoots.add(argument.name);
			},
			MemberExpression(node) {
				if (!isMigratedTransport(context.filename)) return;
				const state = functionState(node);
				const root = rootIdentifier(node);
				if (state !== null && root !== null) state.propertyReadRoots.add(root);
			},
			"Program:exit"() {
				for (const state of functions.values()) {
					const readsGuardedRow = [...state.rowGuardRoots].some((root) =>
						state.propertyReadRoots.has(root)
					);
					if (!readsGuardedRow) continue;
					context.report({ node: state.node, messageId: "handWrittenGuard" });
				}
			},
		};
	},
});
