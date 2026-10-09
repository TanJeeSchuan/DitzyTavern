import { useEffect, useRef } from "react";

const VIEW_BOX = 100;
const CENTER = VIEW_BOX / 2;
const SPHERE_RADIUS = 38;
const POINT_COUNT = 52;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const TILT = -0.4;

type SpherePoint = {
	circle: SVGCircleElement;
	baseX: number;
	baseY: number;
	baseZ: number;
	screenX: number;
	screenY: number;
	radius: number;
	opacity: number;
	depth: number;
};

/** @approved
 * Message-local Generation status inspired by ns-ui's Status Sphere Dots.
 * The smaller point field suits DitzyTavern's 24px author-header placement.
 */
export function GenerationSphere({ authorName }: { authorName: string }) {
	const circlesRef = useRef<(SVGCircleElement | null)[]>([]);

	useEffect(() => {
		const points = circlesRef.current.slice(0, POINT_COUNT).flatMap((circle, index): SpherePoint[] => {
			if (circle === null) return [];
			const y = 1 - (index / (POINT_COUNT - 1)) * 2;
			const radius = Math.sqrt(Math.max(0, 1 - y * y));
			const angle = index * GOLDEN_ANGLE;
			return [{
				circle,
				baseX: Math.cos(angle) * radius,
				baseY: y,
				baseZ: Math.sin(angle) * radius,
				screenX: CENTER,
				screenY: CENTER,
				radius: 0,
				opacity: 0,
				depth: 0,
			}];
		});
		if (points.length !== POINT_COUNT) return;

		const cosineTilt = Math.cos(TILT);
		const sineTilt = Math.sin(TILT);
		const draw = (angle: number) => {
			const cosine = Math.cos(angle);
			const sine = Math.sin(angle);

			for (const point of points) {
				const spunX = point.baseX * cosine + point.baseZ * sine;
				const spunZ = -point.baseX * sine + point.baseZ * cosine;
				const viewedY = point.baseY * cosineTilt - spunZ * sineTilt;
				const viewedZ = point.baseY * sineTilt + spunZ * cosineTilt;
				const normalizedDepth = (viewedZ + 1) * 0.5;
				const perspective = 1 / (1 - viewedZ * 0.21);

				point.screenX = CENTER + spunX * SPHERE_RADIUS * perspective;
				point.screenY = CENTER - viewedY * SPHERE_RADIUS * perspective;
				point.radius = 0.72 + Math.pow(normalizedDepth, 1.45) * 3.2;
				point.opacity = 0.07 + Math.pow(normalizedDepth, 1.35) * 0.93;
				point.depth = viewedZ;
			}

			for (const point of points.toSorted((a, b) => a.depth - b.depth)) {
				const normalizedDepth = (point.depth + 1) * 0.5;
				point.circle.setAttribute("cx", point.screenX.toFixed(2));
				point.circle.setAttribute("cy", point.screenY.toFixed(2));
				point.circle.setAttribute("r", point.radius.toFixed(2));
				point.circle.style.opacity = point.opacity.toFixed(3);
				point.circle.style.fill = normalizedDepth > 0.78
					? "var(--accent)"
					: normalizedDepth > 0.42
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
