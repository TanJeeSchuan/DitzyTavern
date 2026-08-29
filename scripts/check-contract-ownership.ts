import path from "node:path";
// TypeScript 7's package root exposes only version metadata. Keep the stable
// 5.9 compiler API under an explicit alias for repository analysis scripts.
import * as ts from "typescript5";

type Layer = "client" | "contract" | "server" | "shared" | "other";

interface ContractProperty {
	readonly name: string;
	readonly optional: boolean;
	readonly readonly: boolean;
	readonly type: string;
}

interface Representation {
	readonly file: string;
	readonly name: string;
	readonly kind: "interface" | "type" | "schema";
	readonly layer: Layer;
	readonly properties: readonly ContractProperty[];
}

interface StaticDerivation {
	readonly file: string;
	readonly name: string;
	readonly schema: string;
}

const root = process.cwd();
const canonicalDirectory = "src/shared/contract/";

const slash = (value: string): string => value.replaceAll("\\", "/");
const relativeFile = (fileName: string): string => slash(path.relative(root, fileName));

const layerOf = (file: string): Layer => {
	if (file.startsWith(canonicalDirectory)) return "contract";
	if (file.startsWith("src/client/")) return "client";
	if (file.startsWith("src/server/")) return "server";
	if (file.startsWith("src/shared/")) return "shared";
	return "other";
};

const propertyName = (name: ts.PropertyName): string => {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
		return name.text;
	return name.getText();
};

const normalizedType = (node: ts.TypeNode, source: ts.SourceFile): string => {
	if (ts.isArrayTypeNode(node)) return `array<${normalizedType(node.elementType, source)}>`;
	if (ts.isUnionTypeNode(node)) {
		return node.types.map((member) => normalizedType(member, source)).sort().join("|");
	}
	if (ts.isTypeLiteralNode(node)) return `object{${fingerprintProperties(
		typeProperties(node.members, source),
	)}}`;
	if (ts.isTypeReferenceNode(node)) {
		const argumentsText = node.typeArguments?.map((argument) => normalizedType(argument, source));
		return argumentsText?.length
			? `${node.typeName.getText(source)}<${argumentsText.join(",")}>`
			: `ref:${node.typeName.getText(source)}`;
	}
	if (ts.isLiteralTypeNode(node)) return `literal:${node.literal.getText(source)}`;
	if (ts.isParenthesizedTypeNode(node)) return normalizedType(node.type, source);
	return node.getText(source).replaceAll(/\s+/g, "");
};

const typeProperties = (
	members: ts.NodeArray<ts.TypeElement>,
	source: ts.SourceFile,
): readonly ContractProperty[] => members
	.filter(ts.isPropertySignature)
	.filter((member): member is ts.PropertySignature & { name: ts.PropertyName } => member.name !== undefined)
	.map((member) => ({
		name: propertyName(member.name),
		optional: member.questionToken !== undefined,
		readonly: member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false,
		type: member.type === undefined ? "unknown" : normalizedType(member.type, source),
	}))
	.sort((left, right) => left.name.localeCompare(right.name));

const schemaCallName = (expression: ts.Expression): string | null => {
	if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression))
		return null;
	const owner = expression.expression.expression;
	if (!ts.isIdentifier(owner) || (owner.text !== "Type" && owner.text !== "t")) return null;
	return expression.expression.name.text;
};

const unwrapExpression = (expression: ts.Expression): ts.Expression => {
	let current = expression;
	while (
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isParenthesizedExpression(current) ||
		ts.isSatisfiesExpression(current)
	) current = current.expression;
	return current;
};

const normalizedSchema = (raw: ts.Expression, source: ts.SourceFile): string => {
	const expression = unwrapExpression(raw);
	if (ts.isIdentifier(expression)) return `ref:${expression.text}`;
	if (!ts.isCallExpression(expression)) return expression.getText(source).replaceAll(/\s+/g, "");
	const name = schemaCallName(expression);
	const first = expression.arguments[0];
	if (name === "Object" && first !== undefined && ts.isObjectLiteralExpression(first))
		return `object{${fingerprintProperties(schemaProperties(first, source))}}`;
	if (name === "Array" && first !== undefined)
		return `array<${normalizedSchema(first, source)}>`;
	if ((name === "Union" || name === "Intersect") && first !== undefined && ts.isArrayLiteralExpression(first)) {
		const members = first.elements
			.filter(ts.isExpression)
			.map((member) => normalizedSchema(member, source))
			.sort();
		return `${name.toLowerCase()}<${members.join("|")}>`;
	}
	if (name === "Nullable" && first !== undefined)
		return ["null", normalizedSchema(first, source)].sort().join("|");
	if (name === "Optional" && first !== undefined)
		return `optional<${normalizedSchema(first, source)}>`;
	if (name === "Literal" && first !== undefined) return `literal:${first.getText(source)}`;
	if (name !== null) {
		const argumentsText = expression.arguments.map((argument) => normalizedSchema(argument, source));
		return argumentsText.length ? `${name.toLowerCase()}<${argumentsText.join(",")}>` : name.toLowerCase();
	}
	return expression.getText(source).replaceAll(/\s+/g, "");
};

const schemaProperties = (
	object: ts.ObjectLiteralExpression,
	source: ts.SourceFile,
): readonly ContractProperty[] => object.properties
	.filter(ts.isPropertyAssignment)
	.map((property) => {
		const normalized = normalizedSchema(property.initializer, source);
		const optional = normalized.startsWith("optional<");
		return {
			name: propertyName(property.name),
			optional,
			readonly: false,
			type: optional ? normalized.slice("optional<".length, -1) : normalized,
		};
	})
	.sort((left, right) => left.name.localeCompare(right.name));

const fingerprintProperties = (properties: readonly ContractProperty[]): string =>
	properties.map((property) =>
		`${property.readonly ? "readonly " : ""}${property.name}${property.optional ? "?" : ""}:${property.type}`,
	).join(";");

const staticSchemaName = (node: ts.TypeNode, source: ts.SourceFile): string | null => {
	if (!ts.isTypeReferenceNode(node) || node.typeName.getText(source) !== "Static") return null;
	const argument = node.typeArguments?.[0];
	if (argument === undefined || !ts.isTypeQueryNode(argument)) return null;
	return argument.exprName.getText(source);
};

const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
if (configPath === undefined) throw new Error("tsconfig.json was not found");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error !== undefined) {
	throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
}
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });

const representations: Representation[] = [];
const derivations: StaticDerivation[] = [];

for (const source of program.getSourceFiles()) {
	const file = relativeFile(source.fileName);
	if (!file.startsWith("src/") || file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
	for (const statement of source.statements) {
		if (ts.isInterfaceDeclaration(statement)) {
			representations.push({
				file,
				name: statement.name.text,
				kind: "interface",
				layer: layerOf(file),
				properties: typeProperties(statement.members, source),
			});
			continue;
		}
		if (ts.isTypeAliasDeclaration(statement)) {
			const schema = staticSchemaName(statement.type, source);
			if (schema !== null) derivations.push({ file, name: statement.name.text, schema });
			if (ts.isTypeLiteralNode(statement.type)) {
				representations.push({
					file,
					name: statement.name.text,
					kind: "type",
					layer: layerOf(file),
					properties: typeProperties(statement.type.members, source),
				});
			}
			continue;
		}
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
			const expression = unwrapExpression(declaration.initializer);
			if (!ts.isCallExpression(expression) || schemaCallName(expression) !== "Object") continue;
			const object = expression.arguments[0];
			if (object === undefined || !ts.isObjectLiteralExpression(object)) continue;
			representations.push({
				file,
				name: declaration.name.text,
				kind: "schema",
				layer: layerOf(file),
				properties: schemaProperties(object, source),
			});
		}
	}
}

const hardViolations = representations.filter((representation) =>
	representation.kind === "schema" &&
	(representation.layer === "client" || representation.layer === "server"),
);

const exactGroups = new Map<string, Representation[]>();
for (const representation of representations) {
	if (representation.properties.length < 2) continue;
	const fingerprint = fingerprintProperties(representation.properties);
	const group = exactGroups.get(fingerprint) ?? [];
	group.push(representation);
	exactGroups.set(fingerprint, group);
}

const candidatePairs = new Map<string, [Representation, Representation]>();
const fieldSimilarity = (left: Representation, right: Representation): number => {
	const leftNames = new Set(left.properties.map((property) => property.name));
	const rightNames = new Set(right.properties.map((property) => property.name));
	const intersection = [...leftNames].filter((name) => rightNames.has(name)).length;
	const union = new Set([...leftNames, ...rightNames]).size;
	return union === 0 ? 0 : intersection / union;
};

for (const group of exactGroups.values()) {
	if (group.length < 2) continue;
	for (let index = 0; index < group.length; index += 1) {
		for (let other = index + 1; other < group.length; other += 1) {
			const left = group[index];
			const right = group[other];
			if (left.layer === right.layer) continue;
			candidatePairs.set(`${left.file}:${left.name}|${right.file}:${right.name}`, [left, right]);
		}
	}
}

const canonicalSchemas = representations.filter((candidate) =>
	candidate.kind === "schema" && candidate.layer === "contract" && candidate.properties.length >= 3,
);
for (const canonical of canonicalSchemas) {
	for (const other of representations) {
		if (other === canonical || other.layer === "contract" || other.properties.length < 3) continue;
		if (fieldSimilarity(canonical, other) < 0.75) continue;
		candidatePairs.set(
			`${canonical.file}:${canonical.name}|${other.file}:${other.name}`,
			[canonical, other],
		);
	}
}

for (const violation of hardViolations) {
	console.error(`Forbidden wire-schema owner: ${violation.file}  ${violation.name}`);
	console.error("Move the schema to src/shared/contract and import it from this boundary.\n");
}

const pairPriority = ([left, right]: [Representation, Representation]): number => {
	if (/generationSettings/i.test(left.name) || /generationSettings/i.test(right.name)) return 0;
	if (left.layer === "contract" || right.layer === "contract") return 1;
	return 2;
};
const pairs = [...candidatePairs.values()].sort((left, right) =>
	pairPriority(left) - pairPriority(right) ||
	`${left[0].file}:${left[0].name}`.localeCompare(`${right[0].file}:${right[0].name}`),
);
const reportLimit = 12;
for (const [canonicalCandidate, other] of pairs.slice(0, reportLimit)) {
	const [canonical, representation] = canonicalCandidate.layer === "contract"
		? [canonicalCandidate, other]
		: other.layer === "contract"
			? [other, canonicalCandidate]
			: [canonicalCandidate, other];
	console.warn("Possible duplicate contract representation:\n");
	console.warn("Canonical candidate:");
	console.warn(`  ${canonical.file}\n  ${canonical.name}\n`);
	console.warn("Other representation:");
	console.warn(`  ${representation.file}\n  ${representation.name}\n`);
	console.warn("Prefer deriving/importing the canonical contract.\n");
}

console.log(
	`Contract audit: ${representations.length} structural declarations, ` +
	`${derivations.length} Static<typeof Schema> derivations, ${pairs.length} suspicious cross-layer matches.`,
);
if (pairs.length > reportLimit)
	console.log(`Contract audit: ${pairs.length - reportLimit} additional matches omitted.`);
if (hardViolations.length > 0) process.exitCode = 1;
