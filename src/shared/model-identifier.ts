export function compareModelIds(left: string, right: string): number {
	const leftFolded = left.toLocaleLowerCase();
	const rightFolded = right.toLocaleLowerCase();
	if (leftFolded < rightFolded) return -1;
	if (leftFolded > rightFolded) return 1;
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
