import { BoxGeometry, Mesh, MeshNormalMaterial, PerspectiveCamera, Scene, WebGLRenderer } from "three";

let face = null;
let view = { moves: null, disabled: true };
let renderer = "Waiting for its canvas";
const draw = () => host.render(`<div class="dice">
	<canvas data-canvas="die" aria-label="Die" tabindex="0"></canvas>
	<output aria-label="Face">${face ?? "…"}</output>
	<output aria-label="Renderer">${renderer}</output>
</div>`);
host.onRead((read, next) => {
	face = read.face;
	view = next;
	draw();
});
draw();

const scene = new Scene();
const camera = new PerspectiveCamera(40, 1, 0.1, 10);
camera.position.z = 4;
const die = new Mesh(new BoxGeometry(1, 1, 1), new MeshNormalMaterial());
scene.add(die);
let gl;
const frame = () => {
	die.rotation.x += 0.01;
	die.rotation.y += 0.013;
	gl.render(scene, camera);
	requestAnimationFrame(frame);
};
host.canvas("die").then((canvas) => {
	if (canvas === null) renderer = "No canvas";
	else try {
		gl = new WebGLRenderer({ canvas, antialias: true });
		renderer = "WebGL ready";
		frame();
	} catch {
		renderer = "WebGL unavailable";
	}
	draw();
});
host.onCanvasEvent((event) => {
	if (event.type === "resize" && gl !== undefined) {
		gl.setPixelRatio(event.pixelRatio);
		gl.setSize(event.width, event.height, false);
		camera.aspect = event.width / Math.max(event.height, 1);
		camera.updateProjectionMatrix();
	}
	if (event.type === "click" && !view.disabled && view.moves?.length === 0) host.stageMoves([{ sides: 6 }]);
});
