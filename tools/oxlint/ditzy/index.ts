import { noConversationInternalImportsRule } from "./rules/no-conversation-internal-imports.ts";
import { eslintCompatPlugin } from "@oxlint/plugins";

import { noContractDefinitionOutsideContractRule } from "./rules/no-contract-definition-outside-contract.ts";
import { noHandWrittenWireGuardsRule } from "./rules/no-hand-written-wire-guards.ts";
import { noLayerDependenciesInSharedRule } from "./rules/no-layer-dependencies-in-shared.ts";
import { noManualConversationTransactionRule } from "./rules/no-manual-conversation-transaction.ts";
import { noServerRuntimeImportsInClientRule } from "./rules/no-server-runtime-imports-in-client.ts";

const ditzyPlugin = eslintCompatPlugin({
	meta: { name: "ditzy" },
	rules: {
		"no-conversation-internal-imports": noConversationInternalImportsRule,
		"no-contract-definition-outside-contract": noContractDefinitionOutsideContractRule,
		"no-hand-written-wire-guards": noHandWrittenWireGuardsRule,
		"no-layer-dependencies-in-shared": noLayerDependenciesInSharedRule,
		"no-manual-conversation-transaction": noManualConversationTransactionRule,
		"no-server-runtime-imports-in-client": noServerRuntimeImportsInClientRule,
	},
});

export default ditzyPlugin;
