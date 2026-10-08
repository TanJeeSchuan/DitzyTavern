import { useEffect, useRef } from "react";

const VIEW_BOX = 100;
const CENTER = VIEW_BOX / 2;
const SPHERE_RADIUS = 38;
const POINT_COUNT = 52;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const TILT = -0.4;

/** @approved
 * Message-local Generation status inspired by ns-ui's Status Sphere Dots.
 * The smaller point field suits DitzyTavern's 24px author-header placement.
 */
export function GenerationSphere({ authorName }: { authorName: string }) {
	const circlesRef = useRef<(SVGCircleElement | null)[]>([]);

	useEffect(() => {
		const circles = circlesRef.current.slice(0, POINT_COUNT);
		if (circles.some((circle) => circle === null)) return;

		const baseX = new Float64Array(POINT_COUNT);
		const baseY = new Float64Array(POINT_COUNT);
		const baseZ = new Float64Array(POINT_COUNT);
		const screenX = new Float64Array(POINT_COUNT);
		const screenY = new Float64Array(POINT_COUNT);
		const radii = new Float64Array(POINT_COUNT);
		const opacity = new Float64Array(POINT_COUNT);
		const depth = new Float64Array(POINT_COUNT);
		const order = new Int32Array(POINT_COUNT);

		for (let index = 0; index < POINT_COUNT; index += 1) {
			const y = 1 - (index / (POINT_COUNT - 1)) * 2;
			const radius = Math.sqrt(Math.max(0, 1 - y * y));
			const angle = index * GOLDEN_ANGLE;
			baseX[index] = Math.cos(angle) * radius;
			baseY[index] = y;
			baseZ[index] = Math.sin(angle) * radius;
			order[index] = index;
		}

		const cosineTilt = Math.cos(TILT);
		const sineTilt = Math.sin(TILT);
		const draw = (angle: number) => {
			const cosine = Math.cos(angle);
			const sine = Math.sin(angle);

			for (let index = 0; index < POINT_COUNT; index += 1) {
				const spunX = baseX[index]! * cosine + baseZ[index]! * sine;
				const spunZ = -baseX[index]! * sine + baseZ[index]! * cosine;
				const viewedY = baseY[index]! * cosineTilt - spunZ * sineTilt;
				const viewedZ = baseY[index]! * sineTilt + spunZ * cosineTilt;
				const normalizedDepth = (viewedZ + 1) * 0.5;
				const perspective = 1 / (1 - viewedZ * 0.21);

				screenX[index] = CENTER + spunX * SPHERE_RADIUS * perspective;
				screenY[index] = CENTER - viewedY * SPHERE_RADIUS * perspective;
				radii[index] = 0.72 + Math.pow(normalizedDepth, 1.45) * 3.2;
				opacity[index] = 0.07 + Math.pow(normalizedDepth, 1.35) * 0.93;
				depth[index] = viewedZ;
			}

			for (let index = 1; index < POINT_COUNT; index += 1) {
				const point = order[index]!;
				const pointDepth = depth[point]!;
				let position = index - 1;
				while (position >= 0 && depth[order[position]!]! > pointDepth) {
					order[position + 1] = order[position]!;
					position -= 1;
				}
				order[position + 1] = point;
			}

			for (let position = 0; position < POINT_COUNT; position += 1) {
				const point = order[position]!;
				const circle = circles[position]!;
				const pointDepth = (depth[point]! + 1) * 0.5;
				circle.setAttribute("cx", screenX[point]!.toFixed(2));
				circle.setAttribute("cy", screenY[point]!.toFixed(2));
				circle.setAttribute("r", radii[point]!.toFixed(2));
				circle.style.opacity = opacity[point]!.toFixed(3);
				circle.style.fill = pointDepth > 0.78
					? "var(--accent)"
					: pointDepth > 0.42
						? "var(--foreground)"
						: "var(--text-muted)";
			}
		};

		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			draw(0.65);
			return;
		}

		let animationFrame = 0;
		let priorTime = 0;
		let angle = 0.3;
		const animate = (time: number) => {
			const delta = priorTime === 0 ? 1 / 60 : Math.min(0.05, (time - priorTime) / 1000);
			priorTime = time;
			angle += delta * 0.68;
			draw(angle);
			animationFrame = requestAnimationFrame(animate);
		};
		const start = () => {
			if (animationFrame === 0 && !document.hidden) {
				priorTime = 0;
				animationFrame = requestAnimationFrame(animate);
			}
		};
		const stop = () => {
			if (animationFrame === 0) return;
			cancelAnimationFrame(animationFrame);
			animationFrame = 0;
		};
		const handleVisibility = () => {
			if (document.hidden) stop();
			else start();
		};

		document.addEventListener("visibilitychange", handleVisibility);
		start();
		return () => {
			stop();
			document.removeEventListener("visibilitychange", handleVisibility);
		};
	}, []);

	return (
		<span
			className="generation-sphere"
			role="status"
			aria-live="polite"
			aria-atomic="true"
			aria-label={`${authorName} is writing`}
		>
			<svg
				viewBox={`0 0 ${VIEW_BOX} ${VIEW_BOX}`}
				width="28"
				height="28"
				aria-hidden="true"
				focusable="false"
			>
				{Array.from({ length: POINT_COUNT }, (_, index) => (
					<circle
						key={index}
						ref={(circle) => {
							circlesRef.current[index] = circle;
						}}
						cx={CENTER}
						cy={CENTER}
						r="1.5"
					/>
				))}
			</svg>
			<span aria-hidden="true">Writing</span>
		</span>
	);
}
