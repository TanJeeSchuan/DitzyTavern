import { defineRule, type ESTree } from "@oxlint/plugins";

import { repositoryPath } from "../path.ts";

// Migrated transports are recognized by responsibility, not by a literal
// filename list: a client file that owns a transport boundary contract
// (an interface named *Transport) or that is organized as a transport
// module (/transport/ directories or *.transport.* files) must decode
// wire payloads through shared schemas. Everything else — flow reducers,
// presentation helpers, form validation — keeps legitimate non-transport
// validation.
const isTransportSeamPath = (path: string): boolean =>
	path.includes("/transport/") || /[-.]transport\.[cm]?[jt]sx?$/.test(path);

const isClientPath = (path: string): boolean => path.startsWith("src/client/");

const transportInterfaceName = (node: ESTree.Node): string | null =>
	node.type === "TSInterfaceDeclaration" && node.id.name.endsWith("Transport")
		? node.id.name
		: null;

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
		// The interface scan runs while guards are collected; the file is
		// judged once at program exit so declaration order never matters.
		let transportInterfaceFound = false;

		return {
			before() {
				functions.clear();
				transportInterfaceFound = false;
			},
			TSInterfaceDeclaration(node) {
				if (transportInterfaceName(node) === null) return;
				if (isClientPath(repositoryPath(context.filename))) {
					transportInterfaceFound = true;
				}
			},
			CallExpression(node) {
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
				const state = functionState(node);
				const root = rootIdentifier(node);
				if (state !== null && root !== null) state.propertyReadRoots.add(root);
			},
			"Program:exit"() {
				const path = repositoryPath(context.filename);
				if (!(isClientPath(path) && isTransportSeamPath(path)) && !transportInterfaceFound) {
					return;
				}
				for (const state of functions.values()) {
					const readsGuardedRow = [...state.rowGuardRoots].some((root) =>
						state.propertyReadRoots.has(root),
					);
					if (!readsGuardedRow) continue;
					context.report({ node: state.node, messageId: "handWrittenGuard" });
				}
			},
		};
	},
});
