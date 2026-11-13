const WORD = /[\p{L}\p{N}_]/u;

const codePointAt = (value: string, index: number): string | undefined => {
	if (index < 0 || index >= value.length) return undefined;
	const point = value.codePointAt(index);
	return point === undefined ? undefined : String.fromCodePoint(point);
};

const codePointBefore = (value: string, index: number): string | undefined => {
	const previous = value.charCodeAt(index - 1);
	if (Number.isNaN(previous)) return undefined;
	const preceding = value.charCodeAt(index - 2);
	const paired = previous >= 0xdc00 && previous <= 0xdfff && preceding >= 0xd800 && preceding <= 0xdbff;
	return paired ? codePointAt(value, index - 2) : codePointAt(value, index - 1);
};

const isWord = (character: string | undefined): boolean => character !== undefined && WORD.test(character);

export const literalMatches = (message: string, expression: string, caseSensitive: boolean, wholeWord: boolean): boolean => {
	if (expression.length === 0) return false;
	const source = caseSensitive ? message : message.toLowerCase();
	const needle = caseSensitive ? expression : expression.toLowerCase();
	let offset = source.indexOf(needle);
	while (offset >= 0) {
		if (!wholeWord || (!isWord(codePointBefore(source, offset)) && !isWord(codePointAt(source, offset + needle.length)))) return true;
		offset = source.indexOf(needle, offset + Math.max(1, needle.length));
	}
	return false;
};

export const castNameMatches = (text: string, name: string): boolean => literalMatches(text, name, false, true);
