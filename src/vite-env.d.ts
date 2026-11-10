/// <reference types="vite/client" />

/** @approved idiomorph ships no types; the Box frame calls only `morph`. */
declare module "idiomorph" {
	export const Idiomorph: { morph(oldNode: Element, newContent: Node, config?: { morphStyle?: "innerHTML" | "outerHTML"; ignoreActiveValue?: boolean }): void };
}
