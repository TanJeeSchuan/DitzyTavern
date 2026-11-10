import { rolled } from "./roll.js";

export default {
	dependencies: ({ seed }) => ({ seed }),
	moves: { render: ({ sides }, author) => `(${author} rolls a d${sides}.)` },
	records: { initial: null, fold: (_, { face }) => face },
	read: ({ state }) => ({ view: { face: state } }),
	advance: {
		run: async ({ dependencies, moves }) => {
			const [move] = moves;
			if (move === undefined) return { items: [] };
			const face = rolled(dependencies.seed, move.sides);
			return { items: [{ text: `The die shows ${face}.`, priority: 0, pinned: true }], record: { face } };
		},
	},
};
