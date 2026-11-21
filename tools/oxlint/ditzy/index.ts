import { eslintCompatPlugin } from "@oxlint/plugins";

import { noBoxBoundaryImportsRule } from "./rules/no-box-boundary-imports.ts";
import { noContractDefinitionOutsideContractRule } from "./rules/no-contract-definition-outside-contract.ts";
import { noConversationInternalImportsRule } from "./rules/no-conversation-internal-imports.ts";
import { noConversationTableWritesRule } from "./rules/no-conversation-table-writes.ts";
import { noLayerDependenciesInSharedRule } from "./rules/no-layer-dependencies-in-shared.ts";
import { noManualConversationTransactionRule } from "./rules/no-manual-conversation-transaction.ts";
import { noRawServerFetchRule } from "./rules/no-raw-server-fetch.ts";
import { noReexportModuleRule } from "./rules/no-reexport-module.ts";
import { noServerRuntimeImportsInClientRule } from "./rules/no-server-runtime-imports-in-client.ts";
import { noTypeAliasRenameRule } from "./rules/no-type-alias-rename.ts";
import { noUnguardedBoxHookRule } from "./rules/no-unguarded-box-hook.ts";

const ditzyPlugin = eslintCompatPlugin({
	meta: { name: "ditzy" },
	rules: {
		"no-box-boundary-imports": noBoxBoundaryImportsRule,
		"no-contract-definition-outside-contract": noContractDefinitionOutsideContractRule,
		"no-conversation-internal-imports": noConversationInternalImportsRule,
		"no-conversation-table-writes": noConversationTableWritesRule,
		"no-layer-dependencies-in-shared": noLayerDependenciesInSharedRule,
		"no-manual-conversation-transaction": noManualConversationTransactionRule,
		"no-raw-server-fetch": noRawServerFetchRule,
		"no-reexport-module": noReexportModuleRule,
		"no-server-runtime-imports-in-client": noServerRuntimeImportsInClientRule,
		"no-type-alias-rename": noTypeAliasRenameRule,
		"no-unguarded-box-hook": noUnguardedBoxHookRule,
	},
});

export default ditzyPlugin;
