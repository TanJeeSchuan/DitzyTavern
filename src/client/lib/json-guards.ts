// @approved
//  JSON value vocabulary for payloads parsed at the fetch boundary. Only
// JSON scalars, arrays, and plain objects can appear; the type is the
// transport seams' parse target before shared contract schemas decode the
// payload into trusted data.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
