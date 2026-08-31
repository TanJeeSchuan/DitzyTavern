// The Conversation-scoped data namespaces that Import provenance owns. A
// committed import writes its receipt, warnings, source identity, and
// canonical archive under these namespaces through the creation seam; they
// are server-owned afterwards (ADR-0028) and can never be addressed by the
// generic data commands. The declaration lives in shared so the SillyTavern
// adapter, the Conversation data seam, and the wire contract derive from one
// reservation and cannot drift.

// The namespace owning a committed import's provenance: the persisted
// Import receipt, warnings, source identity, counts, and preserved
// per-message author values.
export const IMPORT_NAMESPACE = "import.sillytavern";

// The namespace owning an imported Chat's Canonical Source Archive: the
// immutable parsed source values preserved at commit.
export const ARCHIVE_NAMESPACE = "archive";

// True for every namespace whose Conversation-scoped data is import-owned.
// The generic put-data/delete-data commands reject these namespaces in
// every scope; the import projection is the only writer.
export const isImportOwnedDataNamespace = (namespace: string): boolean =>
	namespace === IMPORT_NAMESPACE || namespace === ARCHIVE_NAMESPACE;

// The same reservation expressed as the wire pattern for the generic data
// commands' namespace field: the transport rejects command bodies that
// address import-owned namespaces before dispatch. The Conversation seam
// enforces the identical reservation through the predicate above; the
// grouped alternation makes the exact-match exclusion explicit.
const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const genericDataNamespacePattern = `^(?!(?:${[
	IMPORT_NAMESPACE,
	ARCHIVE_NAMESPACE,
]
	.map(escapeRegExp)
	.join("|")})$).*`;
