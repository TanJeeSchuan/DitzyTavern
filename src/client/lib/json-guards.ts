// JSON shape guards for payloads parsed at the fetch boundary. Only JSON
// scalars, arrays, and plain objects can appear; constructor identity is
// therefore a sound discriminator here. Shared by the Chat history and
// Chat import transport boundaries, which validate the same wire vocabulary
// so a malformed response can never masquerade as trusted data.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonRow = { [key: string]: JsonValue };

export const isRow = (value: JsonValue): value is JsonRow =>
	value !== null &&
	value !== undefined &&
	!Array.isArray(value) &&
	value.constructor === Object;

export const isString = (value: JsonValue): value is string =>
	value !== null && value !== undefined && value.constructor === String;

export const isNumber = (value: JsonValue): value is number =>
	value !== null && value !== undefined && value.constructor === Number;

export const isBoolean = (value: JsonValue): value is boolean =>
	value !== null && value !== undefined && value.constructor === Boolean;

export const isStringArray = (value: JsonValue): value is string[] =>
	Array.isArray(value) && value.every(isString);
