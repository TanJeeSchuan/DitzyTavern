import { eslintCompatPlugin } from "@oxlint/plugins";

import { noContractDefinitionOutsideContractRule } from "./rules/no-contract-definition-outside-contract.ts";
import { noHandWrittenWireGuardsRule } from "./rules/no-hand-written-wire-guards.ts";
import { noManualConversationTransactionRule } from "./rules/no-manual-conversation-transaction.ts";
import { noRuntimeImportsInSharedRule } from "./rules/no-runtime-imports-in-shared.ts";

const ditzyPlugin = eslintCompatPlugin({
	meta: { name: "ditzy" },
	rules: {
		"no-contract-definition-outside-contract": noContractDefinitionOutsideContractRule,
		"no-hand-written-wire-guards": noHandWrittenWireGuardsRule,
		"no-manual-conversation-transaction": noManualConversationTransactionRule,
		"no-runtime-imports-in-shared": noRuntimeImportsInSharedRule,
	},
});

export default ditzyPlugin;
