// Shared openings textarea conversion for the Cast and Character Library
// editors. Splitting on "\n" keeps blank lines as empty openings, and
// trimming only the end of each line removes stray trailing whitespace and
// Windows carriage returns while leading indentation survives verbatim.
export const openingsFromText = (text: string) =>
	text.split("\n").map((line) => line.trimEnd());
