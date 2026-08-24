export function Portrait({ name, size }: { name?: string; size: "small" | "medium" | "large" }) {
	const initial = name?.trim().charAt(0).toLocaleUpperCase() ?? "?";
	return (
		<span className="portrait" data-size={size} aria-hidden="true">
			<span>{initial}</span>
		</span>
	);
}

