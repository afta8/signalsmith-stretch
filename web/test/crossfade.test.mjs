// loopCrossfade: equal-power seam crossfade with overlap consumption
// (cycle = L - F). Geometry is verified directly on the pre-WASM input
// windows using ramp material (sample value = source time in seconds), so
// exact source positions and gains are provable without going through the
// phase vocoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createProcessor, sineBuffer, rms, hasNaN, QUANTUM} from './harness.mjs';

const SR = 48000;
const S = 0.5, E = 1.0, L = E - S; // default test loop

function rampBuffer({sampleRate = SR, seconds = 2, channels = 2}) {
	const n = Math.round(sampleRate*seconds);
	const out = [];
	for (let c = 0; c < channels; ++c) {
		const b = new Float32Array(n);
		for (let i = 0; i < n; i++) b[i] = i/sampleRate;
		out.push(b);
	}
	return out;
}

async function makeVoice(schedule, {buffer, sampleRate = SR, channels = 2} = {}) {
	const h = await createProcessor({sampleRate, channels});
	h.call('addBuffers', buffer || sineBuffer({sampleRate, seconds: 2, channels}));
	h.call('schedule', {output: h.proc.outputLatencySeconds, ...schedule});
	return h;
}

function readWindow(h, c = 0) {
	const heap = h.proc.wasmModule.HEAP8.buffer;
	return new Float32Array(heap, h.proc.buffersIn[c], h.proc.bufferLength).slice();
}

function positions(h, quanta) {
	const t = [];
	for (let q = 0; q < quanta; q++) { h.render(1); t.push(h.proc.voice.pos); }
	return t;
}

// Independent (spec-derived) expected window value for the cyclic fill
function expectedWindowValue({j, h, rel, dir, style, loopStart = S, loopLen = L, F, sampleRate = SR, bufSeconds = 2}) {
	const n = h.proc.bufferLength;
	const anchor = n - Math.round(h.proc.inputLatencySeconds*sampleRate);
	const Ssamp = loopStart*sampleRate, Lsamp = loopLen*sampleRate, Fsamp = F*sampleRate;
	const cyc = Lsamp - Fsamp;
	const mod = (x, m) => ((x%m) + m)%m;
	const src = i => (i >= 0 && i < bufSeconds*sampleRate) ? Math.round(i)/sampleRate : 0;
	const backwardGrain = (dir < 0 && style !== 'mirror');
	const delta = backwardGrain ? (anchor - j) : (j - anchor);
	const x = rel*sampleRate + dir*delta;
	const cp = (dir > 0) ? Fsamp + mod(x - Fsamp, cyc) : mod(x, cyc);
	if (dir > 0 && cp >= Lsamp - Fsamp) {
		const w = (cp - (Lsamp - Fsamp))/Fsamp;
		return Math.cos(w*Math.PI/2)*src(Ssamp + cp) + Math.sin(w*Math.PI/2)*src(Ssamp + cp - (Lsamp - Fsamp));
	}
	if (dir < 0 && cp <= Fsamp) {
		const w = (Fsamp - cp)/Fsamp;
		return Math.cos(w*Math.PI/2)*src(Ssamp + cp) + Math.sin(w*Math.PI/2)*src(Ssamp + Lsamp - (Fsamp - cp));
	}
	return src(Ssamp + cp);
}

function checkWindowGeometry(h, params, label) {
	const win = readWindow(h);
	const n = win.length;
	let checked = 0;
	for (let j = 0; j < n; j += 37) { // dense-ish sweep
		const want = expectedWindowValue({j, h, ...params});
		assert.ok(Math.abs(win[j] - want) < 1e-3,
			`${label}: window[${j}] = ${win[j].toFixed(5)}, want ${want.toFixed(5)}`);
		checked++;
	}
	assert.ok(checked > 100, `${label}: swept the window`);
}

// ---- Window geometry (pre-WASM), equal-power gains, in-loop reads ----

test('forward +rate window: blended seam geometry and equal-power gains', async () => {
	const F = 0.1;
	const h = await makeVoice({active: true, input: 0.8, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: F, loopTrapped: true}, {buffer: rampBuffer({})});
	h.render(1);
	checkWindowGeometry(h, {rel: 0.3, dir: 1, style: 'grain', F}, 'forward +1');
});

test('forward -rate window: mirrored seam geometry (grain, source-ordered)', async () => {
	const F = 0.1;
	const h = await makeVoice({active: true, input: 0.7, rate: -1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: F, loopTrapped: true}, {buffer: rampBuffer({})});
	h.render(1);
	checkWindowGeometry(h, {rel: 0.2, dir: -1, style: 'grain', F}, 'forward -1');
});

test('mirror reverse return-leg window: coherent blend, single fade, reversed once', async () => {
	const F = 0.08;
	const h = await makeVoice({active: true, input: 0.75, rate: 1, loopStart: S, loopEnd: E, loopMode: 'reverse', reverseStyle: 'mirror', loopCrossfade: F, loopTrapped: true, loopLeg: -1}, {buffer: rampBuffer({})});
	h.render(1);
	checkWindowGeometry(h, {rel: 0.25, dir: -1, style: 'mirror', F}, 'mirror reverse');
});

test('scrub into a fade zone produces the correct blend immediately', async () => {
	const F = 0.1;
	const h = await makeVoice({active: true, input: 0.6, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: F, loopTrapped: true}, {buffer: rampBuffer({})});
	h.render(5);
	// scrub straight into the forward fade zone [E-F, E]
	h.call('schedule', {input: 0.95, loopTrapped: true, output: h.renderedSeconds + h.proc.outputLatencySeconds});
	h.render(1);
	checkWindowGeometry(h, {rel: 0.45, dir: 1, style: 'grain', F}, 'scrub into fade');
});

test('full-buffer loop: both blend reads stay inside the loop (no zero-padding bleed)', async () => {
	const F = 0.2;
	const h = await makeVoice({active: true, input: 1.5, rate: 1, loopStart: 0, loopEnd: 2, loopMode: 'forward', loopCrossfade: F, loopTrapped: true}, {buffer: rampBuffer({})});
	h.render(1);
	checkWindowGeometry(h, {rel: 1.5, dir: 1, style: 'grain', loopStart: 0, loopLen: 2, F}, 'full-buffer');
	const win = readWindow(h);
	for (const v of win) assert.ok(v >= 0 && v < 2, `in-loop value (${v})`);
});

// ---- Overlap consumption ----

test('positive wrap skips the consumed overlap and never replays the head', async () => {
	const F = 0.1;
	const h = await makeVoice({active: true, input: 0.9, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: F, loopTrapped: true});
	const t = positions(h, 400); // several wraps
	let wraps = 0;
	for (let i = 1; i < t.length; i++) {
		if (t[i] < t[i - 1] - 0.01) { // wrapped
			wraps++;
			assert.ok(Math.abs(t[i] - (S + F)) < 0.01, `wrap ${wraps} lands at S+F (${t[i].toFixed(4)})`);
		} else if (i > 5) {
			assert.ok(t[i] >= S + F - 1e-6, `post-first-wrap position never inside consumed head (${t[i].toFixed(4)})`);
		}
	}
	assert.ok(wraps >= 2, `saw multiple wraps (${wraps})`);
});

test('negative wrap lands at E - F (mirrored rule)', async () => {
	const F = 0.1;
	const h = await makeVoice({active: true, input: 0.6, rate: -1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: F, loopTrapped: true});
	const t = positions(h, 400);
	const wrapIdx = t.findIndex((p, i) => i > 0 && p > t[i - 1] + 0.01);
	assert.ok(wrapIdx > 0, 'wrapped');
	assert.ok(Math.abs(t[wrapIdx] - (E - F)) < 0.01, `lands at E-F (${t[wrapIdx].toFixed(4)})`);
});

test('reverse return-leg seams crossfade-skip at both rate signs; the initial turn does not', async () => {
	const F = 0.1;
	// +rate: approach, turn at E (reflection - no skip), then backward wraps 0 -> L-F
	let h = await makeVoice({active: true, input: 0.9, rate: 1, loopStart: S, loopEnd: E, loopMode: 'reverse', loopCrossfade: F});
	let t = positions(h, 700);
	const turnIdx = t.findIndex((p, i) => i > 0 && p < t[i - 1] && t[i - 1] > E - 0.05);
	assert.ok(turnIdx > 0 && t[turnIdx] > E - F, `turn reflects without overlap skip (${t[turnIdx].toFixed(4)})`);
	const wrapIdx = t.findIndex((p, i) => i > turnIdx && p > t[i - 1] + 0.01);
	assert.ok(wrapIdx > 0 && Math.abs(t[wrapIdx] - (E - F)) < 0.01, `backward wrap lands at E-F (${t[wrapIdx].toFixed(4)})`);

	// -rate: turn at S, then forward wraps E -> S+F
	h = await makeVoice({active: true, input: 0.6, rate: -1, loopStart: S, loopEnd: E, loopMode: 'reverse', loopCrossfade: F});
	t = positions(h, 700);
	const wrapIdx2 = t.findIndex((p, i) => i > 5 && p < t[i - 1] - 0.01 && t[i - 1] > E - 0.05);
	assert.ok(wrapIdx2 > 0 && Math.abs(t[wrapIdx2] - (S + F)) < 0.01, `forward wrap lands at S+F (${t[wrapIdx2].toFixed(4)})`);
});

test('seeded reverse return-leg onset wraps with crossfade immediately', async () => {
	const F = 0.1;
	const h = await makeVoice({active: true, input: 0.55, rate: 1, loopStart: S, loopEnd: E, loopMode: 'reverse', loopCrossfade: F, loopTrapped: true, loopLeg: -1});
	const t = positions(h, 100); // travelling backward from 0.55, wraps at S quickly
	const wrapIdx = t.findIndex((p, i) => i > 0 && p > t[i - 1] + 0.01);
	assert.ok(wrapIdx > 0 && Math.abs(t[wrapIdx] - (E - F)) < 0.01, `seeded return-leg wrap lands at E-F (${t[wrapIdx].toFixed(4)})`);
});

test('high rates: multiple seam crossings stay on the L-F cycle (independent modulo oracle)', async () => {
	const F = 0.02, s = 0.5, e = 0.6, l = e - s; // tiny loop, rate 40
	const h = await makeVoice({active: true, input: 0.55, rate: 40, loopStart: s, loopEnd: e, loopMode: 'forward', loopCrossfade: F, loopTrapped: true});
	const mod = (x, m) => ((x%m) + m)%m;
	for (let q = 1; q <= 200; q++) {
		h.render(1);
		const travel = (q - 1)*QUANTUM/SR*40; // first block has zero elapsed travel
		let rel = 0.05 + travel;
		if (rel > l) rel = F + mod(rel - l, l - F);
		const got = h.proc.voice.pos;
		let d = Math.abs(got - (s + rel));
		d = Math.min(d, Math.abs(d - (l - F))); // seam instant ambiguity
		assert.ok(d < 40*2/SR + 1e-6, `q${q}: pos ${got.toFixed(5)} vs oracle ${(s + rel).toFixed(5)}`);
	}
});

// ---- Normalisation, clamping, mode rules ----

test('invalid, negative and non-finite crossfades normalise to zero (bit-identical trajectories)', async () => {
	const base = {active: true, input: 0.6, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward'};
	const ref = positions(await makeVoice(base), 300);
	for (const bad of [-1, NaN, Infinity, '0.05', null]) {
		const t = positions(await makeVoice({...base, loopCrossfade: bad}), 300);
		assert.deepEqual(t, ref, `loopCrossfade=${bad} behaves as zero`);
	}
});

test('crossfade clamps to half the loop width', async () => {
	const h = await makeVoice({active: true, input: 0.9, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 10, loopTrapped: true});
	const t = positions(h, 300);
	const wrapIdx = t.findIndex((p, i) => i > 0 && p < t[i - 1] - 0.01);
	assert.ok(wrapIdx > 0 && Math.abs(t[wrapIdx] - (S + L/2)) < 0.01,
		`wrap skip clamped to L/2 (landed ${t[wrapIdx].toFixed(4)})`);
});

test('ping-pong ignores the crossfade but retains it for a later mode change', async () => {
	const base = {active: true, input: 0.7, rate: 1, loopStart: S, loopEnd: E, loopMode: 'pingpong', loopTrapped: true};
	const a = positions(await makeVoice(base), 400);
	const h = await makeVoice({...base, loopCrossfade: 0.15});
	const b = positions(h, 400);
	assert.deepEqual(b, a, 'pingpong trajectories identical with and without crossfade');
	// switch to forward: the retained value becomes active at the next wrap
	h.call('schedule', {loopMode: 'forward'});
	const t = positions(h, 400);
	const wrapIdx = t.findIndex((p, i) => i > 0 && p < t[i - 1] - 0.01);
	assert.ok(wrapIdx > 0 && Math.abs(t[wrapIdx] - (S + 0.15)) < 0.01,
		`retained crossfade active after mode change (landed ${t[wrapIdx].toFixed(4)})`);
});

test('untrapped and unreachable voices never crossfade', async () => {
	// start beyond the loop: one-shot, trajectory identical to zero-crossfade
	const base = {active: true, input: 1.2, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward'};
	const a = positions(await makeVoice(base), 200);
	const b = positions(await makeVoice({...base, loopCrossfade: 0.1}), 200);
	assert.deepEqual(b, a, 'unreachable one-shot unaffected by crossfade');
});

// ---- Live behaviour ----

test('live crossfade changes neither reset nor untrap the voice', async () => {
	const h = await makeVoice({active: true, input: 0.7, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0.05, loopTrapped: true});
	h.render(50);
	const before = h.proc.voice.pos;
	h.call('schedule', {loopCrossfade: 0.2});
	h.render(1);
	assert.ok(Math.abs(h.proc.voice.pos - before) < 0.01, 'position continuous across the change');
	assert.equal(h.proc.voice.trapped, true);
	const t = positions(h, 400);
	const wrapIdx = t.findIndex((p, i) => i > 0 && p < t[i - 1] - 0.01);
	assert.ok(wrapIdx > 0 && Math.abs(t[wrapIdx] - (S + 0.2)) < 0.01, 'next wrap uses the new overlap');
});

test('marker moves keep the voice trapped and apply the crossfade at the new bounds', async () => {
	const h = await makeVoice({active: true, input: 0.7, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0.1, loopTrapped: true});
	h.render(50);
	h.call('schedule', {loopStart: 1.2, loopEnd: 1.6});
	const t = positions(h, 400);
	assert.equal(h.proc.voice.trapped, true);
	const wrapIdx = t.findIndex((p, i) => i > 2 && p < t[i - 1] - 0.01);
	assert.ok(wrapIdx > 0 && Math.abs(t[wrapIdx] - 1.3) < 0.01,
		`wrap at the moved loop lands at newStart+F (${t[wrapIdx] && t[wrapIdx].toFixed(4)})`);
});

test('rate zero holds inside a fade zone; polarity change switches seam orientation', async () => {
	const h = await makeVoice({active: true, input: 0.95, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0.1, loopTrapped: true}, {buffer: rampBuffer({})});
	h.render(2);
	h.call('schedule', {rate: 0});
	h.render(5);
	const frozen = h.proc.voice.pos;
	const w1 = readWindow(h);
	h.render(5);
	assert.ok(Math.abs(h.proc.voice.pos - frozen) < 1e-9, 'held');
	assert.deepEqual(readWindow(h), w1, 'window stable during hold');
	assert.ok(!hasNaN(w1), 'no NaN held in fade zone');
	h.call('schedule', {rate: -1});
	const t = positions(h, 300);
	const wrapIdx = t.findIndex((p, i) => i > 0 && p > t[i - 1] + 0.01);
	assert.ok(wrapIdx > 0 && Math.abs(t[wrapIdx] - (E - 0.1)) < 0.01, 'backward seam active after polarity change');
});

test('scrubs before, inside and after the loop re-evaluate reachability with crossfade set', async () => {
	const h = await makeVoice({active: true, input: 0.7, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0.1, loopTrapped: true});
	h.render(50);
	h.call('schedule', {input: 1.3, output: h.renderedSeconds + h.proc.outputLatencySeconds});
	h.render(100);
	assert.equal(h.proc.voice.trapped, false, 'scrub past the loop escapes');
	h.call('schedule', {input: 0.2, output: h.renderedSeconds + h.proc.outputLatencySeconds});
	h.render(400);
	assert.equal(h.proc.voice.trapped, true, 'scrub before the loop re-enters and traps');
});

// ---- Styles, channels, sample rates, stability ----

test('grain and mirror share identical crossfade topology positions', async () => {
	const base = {active: true, input: 0.8, rate: 1, loopStart: S, loopEnd: E, loopMode: 'reverse', loopCrossfade: 0.1, loopTrapped: true, loopLeg: -1};
	const g = positions(await makeVoice(base), 400);
	const m = positions(await makeVoice({...base, reverseStyle: 'mirror'}), 400);
	assert.deepEqual(m, g, 'identical positions across styles');
});

test('crossfaded loops render cleanly: mono/stereo, 44.1k/48k, short loops, repeatable', async () => {
	for (const sampleRate of [44100, 48000]) {
		for (const channels of [1, 2]) {
			const buffer = sineBuffer({sampleRate, seconds: 1.5, channels, freq: 330});
			const mk = () => makeVoice({active: true, input: 0.42, rate: 1.5, loopStart: 0.4, loopEnd: 0.9, loopMode: 'forward', loopCrossfade: 0.08, loopTrapped: true}, {buffer, sampleRate, channels});
			const a = await mk(), b = await mk();
			const oa = a.render(500), ob = b.render(500);
			for (let c = 0; c < channels; c++) {
				assert.ok(!hasNaN(oa[c]), 'no NaN');
				assert.ok(rms(oa[c].subarray(oa[c].length >> 1)) > 0.05, 'sustained energy');
				for (let i = 0; i < oa[c].length; i++) {
					if (!Object.is(oa[c][i], ob[c][i])) assert.fail(`non-deterministic at ${i}`);
				}
			}
		}
	}
	// loop shorter than the analysis window
	const h = await makeVoice({active: true, input: 0.502, rate: 1, loopStart: 0.5, loopEnd: 0.505, loopMode: 'forward', loopCrossfade: 0.002, loopTrapped: true});
	const out = h.render(300)[0];
	assert.ok(!hasNaN(out), 'short loop: no NaN');
	const p = h.proc.voice.pos;
	assert.ok(p >= 0.5 && p <= 0.505, 'short loop: stays bounded');
});

test('natural-end notifications are unaffected by crossfade settings', async () => {
	const h = await makeVoice({active: true, input: 1.2, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0.1, playEnd: 1.5});
	h.render(300);
	const ev = h.posted.filter(m => m[0] === 'ended');
	assert.equal(ev.length, 1);
	assert.ok(Math.abs(ev[0][1].position - 1.5) < 0.05, 'ended at playEnd as before');
});

// ---- End-to-end audio: the seam is audibly softened ----

test('crossfade softens a deliberately discontinuous seam (end-to-end)', async () => {
	// loop material: loud near the loop end, quiet at the head -> hard level
	// step at every wrap when F=0
	const n = SR*2;
	const buf = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const t = i/SR;
		const amp = (t >= S && t <= E) ? 0.1 + 0.8*((t - S)/L) : 0.3;
		buf[i] = Math.sin(2*Math.PI*330*i/SR)*amp;
	}
	async function seamRoughness(F) {
		const h = await makeVoice({active: true, input: 0.6, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: F, loopTrapped: true}, {buffer: [buf, buf.slice()]});
		const out = h.render(1200)[0];
		const chunk = Math.round(0.01*SR);
		let maxStep = 0;
		for (let s2 = Math.round(0.5*SR); s2 + 2*chunk < out.length; s2 += chunk) {
			const a = rms(out.subarray(s2, s2 + chunk));
			const b = rms(out.subarray(s2 + chunk, s2 + 2*chunk));
			maxStep = Math.max(maxStep, Math.abs(b - a));
		}
		return maxStep;
	}
	const hard = await seamRoughness(0);
	const soft = await seamRoughness(0.12);
	assert.ok(soft < hard*0.7, `crossfade softens the level step (hard ${hard.toFixed(4)} -> soft ${soft.toFixed(4)})`);
});
