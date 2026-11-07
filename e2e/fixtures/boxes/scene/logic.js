// The record is the whole stage after its passage, so the fold keeps the last one.
const apply = (props, { kind, prop }) => {
	if (kind === "place" && props.includes(prop)) throw new Error(`The ${prop} is already on stage.`);
	if (kind === "remove" && !props.includes(prop)) throw new Error(`There is no ${prop} on stage.`);
	return kind === "place" ? [...props, prop] : props.filter((held) => held !== prop);
};

export default {
	records: { initial: [], fold: (_, { props }) => props },
	read: ({ state }) => ({ view: { props: state }, status: state.length === 1 ? "1 prop" : `${state.length} props` }),
	delegate: { apply: ({ state, operations }) => ({ props: operations.reduce(apply, state) }) },
	advance: { run: ({ state }) => ({ items: state.length === 0 ? [] : [{ text: `On stage: ${state.join(", ")}.`, priority: 0, pinned: true }] }) },
};
