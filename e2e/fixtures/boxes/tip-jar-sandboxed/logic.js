export default {
	moves: { render: ({ coins }, author) => `(${author} drops ${coins} coin in the tip jar.)` },
	records: { initial: 0, fold: (total, { coins }) => total + coins },
	read: ({ state }) => ({ view: { coins: state } }),
	advance: {
		run: async ({ state, moves }) => {
			const coins = moves.reduce((sum, move) => sum + move.coins, 0);
			return { items: [{ text: `The tip jar holds ${state + coins} coins.`, priority: 0, pinned: true }], record: { coins } };
		},
	},
};
