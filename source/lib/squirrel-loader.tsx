import { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";

// ─────────────────────────────────────────────────────────────────────────
// 3D rendered squirrel via SDF + sphere tracing.
//
// Anatomy is composed of ellipsoid/sphere/capsule primitives blended with
// smooth-min so the silhouette looks organic. Per-pixel ray-marching
// finds the surface; surface normals are finite-differenced. Lighting
// combines Lambertian diffuse, soft shadows (Inigo Quilez technique),
// and ambient occlusion. Brightness picks a glyph from a luminance ramp;
// world-Y position picks a rainbow color band (red top → blue bottom)
// with shadow/lit two-tone variants.
//
// Animation runs on three independent phases per loop (so nothing reads
// as a single synchronised pendulum):
//   - body angle: 1 full Y-rotation (every face visible)
//   - tail phase: 3 wag cycles
//   - anim phase: 1 cycle, with BodyAnim curves using internal multiples
//     (×5 for ear flicks, ×2 for acorn jiggle) for per-part timing
// ─────────────────────────────────────────────────────────────────────────

const W = 100;
const H = 40;
const FRAME_COUNT = 36;
const FRAME_MS = 80;
const RAMP = ".,-~:;=!*#$@";

// ── Vector math ─────────────────────────────────────────────────────
type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addV = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vlen = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const vscale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
function vnorm(a: V3): V3 {
	const l = vlen(a) || 1;
	return [a[0] / l, a[1] / l, a[2] / l];
}
// Rotate around Y axis. `c`/`s` are precomputed cos/sin so callers can
// share them across many evals at the same angle.
const rotY = (p: V3, c: number, s: number): V3 => [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]];

// ── SDF primitives ──────────────────────────────────────────────────
function sdEllipsoid(p: V3, r: V3): number {
	const k0 = Math.hypot(p[0] / r[0], p[1] / r[1], p[2] / r[2]);
	const k1 = Math.hypot(p[0] / (r[0] * r[0]), p[1] / (r[1] * r[1]), p[2] / (r[2] * r[2]));
	return (k0 * (k0 - 1)) / Math.max(0.0001, k1);
}
const sdSphere = (p: V3, r: number): number => vlen(p) - r;
function sdCapsule(p: V3, a: V3, b: V3, r: number): number {
	const pa = sub(p, a);
	const ba = sub(b, a);
	const h = Math.max(0, Math.min(1, dot(pa, ba) / dot(ba, ba)));
	return vlen(sub(pa, vscale(ba, h))) - r;
}
function smin(a: number, b: number, k: number): number {
	const h = Math.max(0, k - Math.abs(a - b)) / k;
	return Math.min(a, b) - h * h * k * 0.25;
}

// ── Animation curves ────────────────────────────────────────────────
// Tail joint base positions. Peak (j5) is at y=2.7, level with the ear
// tips — tail no longer towers over the silhouette. Tip is well to the
// left (x=-1.1) and behind (z=0.0) so it stays clear of the head/ears.
const TAIL_BASES: V3[] = [
	[-1.4, -0.4, -0.4], // anchor at rump
	[-1.9, 0.3, -0.6],
	[-2.2, 1.1, -0.6],
	[-2.3, 1.9, -0.4], // peak of outward arc
	[-1.9, 2.5, -0.2],
	[-1.1, 2.7, 0.0], // tip — at ear height, behind & left of head
];

// Per-frame tail joints: amplitude scales with joint index (rump stays
// anchored, tip flicks). Phase shift per joint creates a travelling
// wave instead of a synchronised wag.
function computeTailJoints(phase: number): V3[] {
	return TAIL_BASES.map((b, i) => {
		const amp = i / 5;
		const wagX = Math.sin(phase + i * 0.6) * 0.7 * amp;
		const liftY = Math.cos(phase * 0.9 + i * 0.4) * 0.5 * amp;
		return [b[0] + wagX, b[1] + liftY, b[2]];
	});
}

// Per-frame body animation. Most offsets are in body-local Y (= world Y
// since rotation is around Y) so they don't interact with the body spin.
// Amplitudes are calibrated for 100×40 char resolution (14 chars per
// world unit X, 7 chars per world unit Y) — each motion is at least
// 2 cells of displacement so it reads as deliberate animation.
interface BodyAnim {
	bodyBobY: number; // whole-body breathing
	stretchY: number; // squash/stretch ratio: + = taller, - = compressed
	headExtraY: number; // head bobs out of sync with body
	headTurnAngle: number; // head Y-rotation (look L/R around the neck)
	headLeanZ: number; // head leans forward/back (sniff distance)
	earLExtraY: number; // left ear flick
	earRExtraY: number; // right ear flick (out of phase with L)
	snoutWiggleZ: number; // snout wiggle (fast sniffle)
	pawForwardZ: number; // paws + acorn shift forward together
	acornBobY: number; // acorn jiggle in paws
}

function computeBodyAnim(phase: number): BodyAnim {
	const bobY = Math.sin(phase) * 0.35;
	return {
		bodyBobY: bobY,
		stretchY: bobY * 0.4,
		headExtraY: Math.sin(phase * 1.6 + 0.5) * 0.18,
		headTurnAngle: Math.sin(phase * 0.7) * 0.45,
		headLeanZ: Math.sin(phase * 1.3 + 1.0) * 0.18,
		earLExtraY: Math.max(0, Math.sin(phase * 5)) * 0.35,
		earRExtraY: Math.max(0, Math.sin(phase * 5 + 1.7)) * 0.35,
		snoutWiggleZ: Math.sin(phase * 4) * 0.1,
		pawForwardZ: Math.max(0, Math.sin(phase * 3 - 0.5)) * 0.15,
		acornBobY: Math.sin(phase * 2 + 1) * 0.15,
	};
}

// ── SDF evaluation ──────────────────────────────────────────────────

// All per-frame state needed to evaluate the squirrel SDF. Bundled so
// helpers don't need to plumb 5 arguments each.
interface FrameState {
	cosA: number; // cos of camera Y-spin
	sinA: number;
	tj: V3[]; // tail joint positions
	anim: BodyAnim;
}

// Tail capsule radii from base (rump) to tip. Defined alongside the
// joint positions so anyone tweaking shape sees both at once.
const TAIL_RADII = [0.5, 0.6, 0.65, 0.6, 0.45];

function tailSDF(p: V3, tj: V3[]): number {
	const t1 = sdCapsule(p, tj[0]!, tj[1]!, TAIL_RADII[0]!);
	const t2 = sdCapsule(p, tj[1]!, tj[2]!, TAIL_RADII[1]!);
	const t3 = sdCapsule(p, tj[2]!, tj[3]!, TAIL_RADII[2]!);
	const t4 = sdCapsule(p, tj[3]!, tj[4]!, TAIL_RADII[3]!);
	const t5 = sdCapsule(p, tj[4]!, tj[5]!, TAIL_RADII[4]!);
	// Internal smooth-min keeps the tail one continuous bushy curve.
	return smin(smin(smin(t1, t2, 0.3), smin(t3, t4, 0.3), 0.3), t5, 0.3);
}

// SDF evaluated in body-local space (point already rotated by camera
// spin). Returns signed distance to the squirrel surface.
function squirrelLocal(p: V3, state: FrameState): number {
	const { tj, anim } = state;

	// Whole-body bob: shift the eval point down by bodyBobY, equivalent
	// to moving the body up by bodyBobY. The tail uses ps too so it
	// bobs with the body.
	const ps: V3 = [p[0], p[1] - anim.bodyBobY, p[2]];

	// Volume-preserving squash & stretch: Y grows when stretchY > 0,
	// X/Z shrink slightly to compensate.
	const sy = 1 + anim.stretchY;
	const sxz = 1 - anim.stretchY * 0.5;

	// Pear-shape body: wider haunches, narrower chest.
	const haunches = sdEllipsoid(sub(ps, [0, -0.3, 0]), [1.2 * sxz, 1.0 * sy, 1.0 * sxz]);
	const chest = sdEllipsoid(sub(ps, [0, 0.7, 0.1]), [0.9 * sxz, 0.9 * sy, 0.85 * sxz]);
	const body = smin(haunches, chest, 0.3);

	// Head primitives evaluated in a head-local frame: rotate the eval
	// point around a neck pivot by -headTurnAngle so the head appears
	// to look L/R while the body stays straight.
	const headPivot: V3 = [0, 1.4, 0.2];
	const cosTurn = Math.cos(anim.headTurnAngle);
	const sinTurn = Math.sin(anim.headTurnAngle);
	const psHead: V3 = addV(rotY(sub(ps, headPivot), cosTurn, sinTurn), headPivot);
	const lean = anim.headLeanZ;

	const head = sdEllipsoid(sub(psHead, [0, 1.85 + anim.headExtraY, 0.4 + lean]), [0.7, 0.65, 0.7]);
	const snout = sdEllipsoid(
		sub(psHead, [0, 1.65 + anim.headExtraY, 1.0 + lean + anim.snoutWiggleZ]),
		[0.32, 0.28, 0.4],
	);
	const earL = sdEllipsoid(
		sub(psHead, [-0.45, 2.7 + anim.earLExtraY, 0.25 + lean]),
		[0.16, 0.45, 0.18],
	);
	const earR = sdEllipsoid(
		sub(psHead, [0.45, 2.7 + anim.earRExtraY, 0.25 + lean]),
		[0.16, 0.45, 0.18],
	);

	// Paws + acorn shift forward together (nibble lunge).
	const pe = anim.pawForwardZ;
	const pawL = sdSphere(sub(ps, [-0.45, 0.7, 0.95 + pe]), 0.3);
	const pawR = sdSphere(sub(ps, [0.45, 0.7, 0.95 + pe]), 0.3);
	const acorn = sdEllipsoid(sub(ps, [0, 0.55 + anim.acornBobY, 1.15 + pe]), [0.22, 0.28, 0.22]);

	const tail = tailSDF(ps, tj);

	let d = body;
	d = smin(d, head, 0.25);
	d = smin(d, snout, 0.2);
	d = Math.min(d, earL); // hard union for ears (keeps them pointy)
	d = Math.min(d, earR);
	d = smin(d, pawL, 0.2);
	d = smin(d, pawR, 0.2);
	d = Math.min(d, acorn);
	d = Math.min(d, tail); // hard union: tail is its own visible silhouette
	return d;
}

// SDF at a world-space point: rotates into body-local frame, evaluates.
function evalAt(p: V3, state: FrameState): number {
	return squirrelLocal(rotY(p, state.cosA, state.sinA), state);
}

function calcNormal(p: V3, state: FrameState): V3 {
	const e = 0.01;
	return vnorm([
		evalAt(addV(p, [e, 0, 0]), state) - evalAt(addV(p, [-e, 0, 0]), state),
		evalAt(addV(p, [0, e, 0]), state) - evalAt(addV(p, [0, -e, 0]), state),
		evalAt(addV(p, [0, 0, e]), state) - evalAt(addV(p, [0, 0, -e]), state),
	]);
}

// Soft shadow via light-direction march (Inigo Quilez technique). The
// closest miss along the ray gives a partial shadow; the k=10 multiplier
// controls penumbra softness.
function softShadow(origin: V3, dir: V3, state: FrameState): number {
	let res = 1.0;
	let t = 0.05; // step off the surface to avoid self-occlusion
	for (let step = 0; step < 20; step++) {
		const sp: V3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
		const d = evalAt(sp, state);
		if (d < 0.001) return 0;
		res = Math.min(res, (10 * d) / t);
		t += d;
		if (t > 8) break;
	}
	return Math.max(0, Math.min(1, res));
}

// Cheap ambient occlusion: sample SDF along the surface normal at
// increasing distances. Concave creases (ear bases, where tail meets
// body, under the chin) get darker because nearby geometry blocks the
// ambient light.
function ao(p: V3, n: V3, state: FrameState): number {
	let occ = 0;
	let sca = 1.0;
	for (let i = 0; i < 5; i++) {
		const h = 0.04 + 0.12 * i;
		const sp: V3 = [p[0] + n[0] * h, p[1] + n[1] * h, p[2] + n[2] * h];
		const d = evalAt(sp, state);
		occ += (h - d) * sca;
		sca *= 0.85;
	}
	return Math.max(0, Math.min(1, 1.0 - 0.8 * occ));
}

// ── Frame construction ──────────────────────────────────────────────

const LIGHT = vnorm([0.5, 0.6, -0.6] as V3);

// Viewport in world space (orthographic). The squirrel spans roughly
// y=-1 (paws) to y=4.5 (ear tips), x=-2.5 (tail) to x=1.5 (snout).
const VIEW_X_MIN = -3.5;
const VIEW_X_MAX = 3.5;
const VIEW_Y_MID = 1.75;
const VIEW_Y_HALF = 2.75;
const RAY_MAX_T = 12;
const RAY_MAX_STEPS = 60;
const HIT_EPS = 0.01;
// Ambient floor keeps shadow regions clearly visible. A floor of 0.12
// produced internal "holes" in the silhouette that broke the shape.
const AMBIENT = 0.35;

type Cell = { ch: string; y: number; lit: number };
type Frame = Cell[][];

const EMPTY_CELL: Cell = { ch: " ", y: 0, lit: 0 };

function buildFrame(angle: number, tailPhase: number, animPhase: number): Frame {
	const state: FrameState = {
		cosA: Math.cos(angle),
		sinA: Math.sin(angle),
		tj: computeTailJoints(tailPhase),
		anim: computeBodyAnim(animPhase),
	};
	const grid: Frame = Array.from({ length: H }, () =>
		Array.from({ length: W }, () => ({ ...EMPTY_CELL })),
	);

	for (let py = 0; py < H; py++) {
		for (let px = 0; px < W; px++) {
			const xw = VIEW_X_MIN + (px / (W - 1)) * (VIEW_X_MAX - VIEW_X_MIN);
			const yw = VIEW_Y_MID + (1 - (py / (H - 1)) * 2) * VIEW_Y_HALF;

			// Sphere-trace from in front of the model toward +Z (orthographic).
			let t = 0;
			let p: V3 = [xw, yw, -5];
			let hit = false;
			for (let step = 0; step < RAY_MAX_STEPS; step++) {
				p = [xw, yw, -5 + t];
				const d = evalAt(p, state);
				if (d < HIT_EPS) {
					hit = true;
					break;
				}
				if (t > RAY_MAX_T) break;
				t += d;
			}
			if (!hit) continue;

			const n = calcNormal(p, state);
			const diffuse = Math.max(0, dot(n, LIGHT));
			// Offset shadow ray origin along the normal so we don't
			// immediately re-hit the surface we just landed on.
			const shadowOrigin: V3 = [p[0] + n[0] * 0.03, p[1] + n[1] * 0.03, p[2] + n[2] * 0.03];
			const sh = softShadow(shadowOrigin, LIGHT, state);
			const occ = ao(p, n, state);
			const lit = Math.min(1, AMBIENT + (1 - AMBIENT) * diffuse * sh * occ);
			const idx = Math.min(RAMP.length - 1, Math.floor(lit * 1.3 * RAMP.length));
			// World Y = p[1] (rotY only rotates around Y, so Y is preserved).
			grid[py]![px] = { ch: RAMP[idx]!, y: p[1], lit };
		}
	}
	return grid;
}

// Pre-compute every frame at module load; render path stays at zero
// math per tick.
const FRAMES: Frame[] = (() => {
	const out: Frame[] = [];
	for (let i = 0; i < FRAME_COUNT; i++) {
		const t = i / FRAME_COUNT;
		const angle = t * Math.PI * 2;
		const tailPhase = t * Math.PI * 6; // 3 wag cycles per loop
		const animPhase = t * Math.PI * 2;
		out.push(buildFrame(angle, tailPhase, animPhase));
	}
	return out;
})();

// ── Color rendering ─────────────────────────────────────────────────
// Each band has lit/shadow variants of the same hue. Bundling them
// into one array means adding a band is a single-line change.
const COLOR_BANDS: { lit: string; shadow: string }[] = [
	{ lit: "redBright", shadow: "red" }, // top of head/ears
	{ lit: "yellowBright", shadow: "yellow" },
	{ lit: "yellowBright", shadow: "yellow" },
	{ lit: "greenBright", shadow: "green" },
	{ lit: "cyanBright", shadow: "cyan" },
	{ lit: "cyanBright", shadow: "cyan" },
	{ lit: "blueBright", shadow: "blue" }, // bottom (paws/feet)
];
// World Y range mapped onto bands. Squirrel spans roughly y=-1..3.5.
const COLOR_Y_MIN = -1;
const COLOR_Y_RANGE = 4.5;
const SHADOW_THRESHOLD = 0.5;

function colorForCell(y: number, lit: number): string {
	const t = Math.max(0, Math.min(0.999, (y - COLOR_Y_MIN) / COLOR_Y_RANGE));
	const idx = Math.min(
		COLOR_BANDS.length - 1,
		Math.max(0, Math.floor((1 - t) * COLOR_BANDS.length)),
	);
	const band = COLOR_BANDS[idx]!;
	return lit < SHADOW_THRESHOLD ? band.shadow : band.lit;
}

// ── React component ─────────────────────────────────────────────────

interface Props {
	text?: string;
	/** Optional version line (e.g. santree's running version), shown under `text`. */
	version?: string;
}

/** Animated 3D squirrel for loading states. SDF ray-marched at module
 * load with surface-normal lighting, soft shadows, AO, and a rainbow
 * Y-gradient. Body spin + tail wag + breathing/sniff/ear-flick layers
 * combine over independent phases. */
export default function SquirrelLoader({ text, version }: Props) {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), FRAME_MS);
		return () => clearInterval(id);
	}, []);

	// Coalesce contiguous same-color cells into single Text spans —
	// without this we'd hand Ink ~4000 nodes per frame and stutter.
	const rows = useMemo(() => {
		const grid = FRAMES[frame]!;
		return grid.map((row) => {
			type Span = { text: string; color: string | undefined };
			const spans: Span[] = [];
			let cur: Span | null = null;
			for (const cell of row) {
				const color = cell.ch === " " ? undefined : colorForCell(cell.y, cell.lit);
				if (!cur || cur.color !== color) {
					cur = { text: cell.ch, color };
					spans.push(cur);
				} else {
					cur.text += cell.ch;
				}
			}
			return spans;
		});
	}, [frame]);

	return (
		<Box flexDirection="column" alignItems="center">
			{rows.map((spans, i) => (
				<Box key={i}>
					<Text>
						{spans.map((s, j) => (
							<Text key={j} color={s.color}>
								{s.text}
							</Text>
						))}
					</Text>
				</Box>
			))}
			{text && (
				<Box marginTop={1}>
					<Text dimColor>{text}</Text>
				</Box>
			)}
			{version && (
				<Box>
					<Text dimColor>v{version}</Text>
				</Box>
			)}
		</Box>
	);
}
