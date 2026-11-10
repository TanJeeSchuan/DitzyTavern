let coins;
let view = { moves: null, disabled: true };
const draw = () => host.render(`<div class="tip-jar">
	<output aria-label="Coins in the jar">${coins ?? "…"}</output>
	<button type="button" data-on="drop"${view.disabled || view.moves === null || view.moves.length > 0 ? " disabled" : ""}>Drop a coin</button>
</div>`);
host.onRead((read, next) => {
	coins = read.coins;
	view = next;
	draw();
});
host.onEvent(({ type, name }) => {
	if (type === "click" && name === "drop") host.stageMoves([{ coins: 1 }]);
});
draw();
