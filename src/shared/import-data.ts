// @approved
//  The Conversation-scoped data namespaces that Import provenance owns. A
// committed import writes its receipt, warnings, source identity, and
// canonical archive under these namespaces through the creation seam; they
// are server-owned afterwards (ADR-0028) and can never be addressed by the
// generic data commands. The declaration lives in shared so the SillyTavern
// adapter, the Conversation data seam, and the wire contract derive from one
// reservation and cannot drift.

// @approved
//  The namespace owning a committed import's provenance: the persisted
// Import receipt, warnings, source identity, counts, and preserved
// per-message author values.
export const IMPORT_NAMESPACE = "import.sillytavern";

// @approved
//  The namespace owning an imported Chat's Canonical Source Archive: the
// immutable parsed source values preserved at commit.
export const ARCHIVE_NAMESPACE = "archive";

import { LORE_ACTIVATION_NAMESPACE } from "./contract/lore-activation";
import { MEMORY_ACTIVATION_NAMESPACE } from "./contract/memory-recall";

const importOwnedDataNamespaces = [IMPORT_NAMESPACE, ARCHIVE_NAMESPACE] as const;
const serverOwnedDataNamespaces = [
	...importOwnedDataNamespaces,
	LORE_ACTIVATION_NAMESPACE,
	MEMORY_ACTIVATION_NAMESPACE,
] as const;

// @approved
//  True for every namespace whose Conversation-scoped data is import-owned.
// The generic put-data/delete-data commands reject these namespaces in
// every scope; the import projection is the only writer.
export const isImportOwnedDataNamespace = (namespace: string): boolean =>
	importOwnedDataNamespaces.some((ownedNamespace) => ownedNamespace === namespace);

export const isServerOwnedDataNamespace = (namespace: string): boolean =>
	serverOwnedDataNamespaces.some((ownedNamespace) => ownedNamespace === namespace);

const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const genericDataNamespacePattern = `^(?!(?:${serverOwnedDataNamespaces
	.map(escapeRegExp)
	.join("|")})$).*`;
