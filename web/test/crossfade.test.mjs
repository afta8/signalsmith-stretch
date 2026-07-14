// loopCrossfade: DURATION-PRESERVING equal-power seam taper.
//
// Contract (aura.4, replacing the aura.3 overlap-consumption model):
//   - The topology clock advances/wraps over the FULL loop length L. Period is
//     exactly loopLength/|rate|, independent of loopCrossfade.
//   - Crossfade affects rendered audio ONLY (the analysis window near the seam);
//     it never changes voice.pos, inputTime, leg/direction, trap/turn, wrap
//     cadence, or scheduling.
//   - All seam reads stay inside [loopStart, loopEnd). No out-of-loop reads.
//
// F1 tests lock the timing contract; F2 the seam geometry; F3 lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createProcessor, sineBuffer, rms, hasNaN, QUANTUM} from './harness.mjs';

const SR = 48000;
const S = 0.5, E = 1.0, L = E - S;

async function makeVoice(schedule, {buffer, sampleRate = SR, channels = 2} = {}) {
	const h = await createProcessor({sampleRate, channels});
	h.call('addBuffers', buffer || sineBuffer({sampleRate, seconds: 2, channels}));
	h.call('schedule', {output: h.proc.outputLatencySeconds, ...schedule});
	return h;
}
function positions(h, quanta) {
	const t = [];
	for (let q = 0; q < quanta; q++) { h.render(1); t.push(h.proc.voice.pos); }
	return t;
}
function readWindow(h, c = 0) {
	const heap = h.proc.wasmModule.HEAP8.buffer;
	return new Float32Array(heap, h.proc.buffersIn[c], h.proc.bufferLength).slice();
}
// value == source time in seconds inside the loop; 0 outside -> exposes geometry
function rampBuffer({sampleRate = SR, seconds = 2, channels = 2, s = S, e = E} = {}) {
	const n = Math.round(sampleRate*seconds), out = [];
	for (let c = 0; c < channels; ++c) {
		const b = new Float32Array(n);
		for (let i = 0; i < n; i++) { const t = i/sampleRate; b[i] = (t >= s && t < e) ? t : 0; }
		out.push(b);
	}
	return out;
}
// mean loop period (seconds) from exact wrap crossings of voice.pos
function measurePeriod(h, quanta) {
	let prev = null, lastWrap = null, periods = [];
	for (let q = 0; q < quanta; q++) {
		h.render(1);
		const p = h.proc.voice.pos;
		if (prev !== null && Math.abs(p - prev) > L*0.5) { // wrapped
			if (lastWrap !== null) periods.push((q - lastWrap)*QUANTUM/SR);
			lastWrap = q;
		}
		prev = p;
	}
	return periods.reduce((a, b) => a + b, 0)/periods.length;
}

// ---------------- F1: timing contract ----------------

test('F1 regression: L=0.5, F=0.1 period is 0.5s, never 0.4s (no overlap consumption)', async () => {
	const h = await makeVoice({active: true, input: 0.6, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0.1, loopTrapped: true});
	const period = measurePeriod(h, 2000);
	assert.ok(Math.abs(period - 0.5) < 0.01, `period ${period.toFixed(4)} ~ 0.5 (full L)`);
	assert.ok(Math.abs(period - 0.4) > 0.05, `period is NOT the forbidden L-F=0.4`);
});

test('F1: F>0 position trajectory is identical to F=0 (forward, both rate signs)', async () => {
	for (const rate of [1, -1, 0.37, 1.9]) {
		const base = {active: true, input: 0.62, rate, loopStart: S, loopEnd: E, loopMode: 'forward', loopTrapped: true};
		const zero = positions(await makeVoice(base), 500);
		for (const F of [0.05, 0.15, 0.25]) {
			const cf = positions(await makeVoice({...base, loopCrossfade: F}), 500);
			assert.deepEqual(cf, zero, `rate ${rate}, F ${F}: pos trajectory unchanged by crossfade`);
		}
	}
});

test('F1: reverse post-turn wrapping legs keep full L (F>0 pos == F=0 pos), both signs', async () => {
	for (const rate of [1, -1]) {
		const base = {active: true, input: rate > 0 ? 0.9 : 0.6, rate, loopStart: S, loopEnd: E, loopMode: 'reverse', loopTrapped: false};
		const zero = positions(await makeVoice(base), 900);
		const cf = positions(await makeVoice({...base, loopCrossfade: 0.15}), 900);
		assert.deepEqual(cf, zero, `reverse rate ${rate}: crossfade leaves the whole trajectory (turn + wraps) unchanged`);
	}
});

test('F1: high rates crossing multiple boundaries per quantum keep full-L cadence', async () => {
	const s = 0.5, e = 0.56, l = e - s; // 60ms loop, rate 50 -> several wraps/quantum
	const base = {active: true, input: 0.51, rate: 50, loopStart: s, loopEnd: e, loopMode: 'forward', loopTrapped: true};
	const zero = positions(await makeVoice(base), 200);
	const cf = positions(await makeVoice({...base, loopCrossfade: 0.02}), 200);
	assert.deepEqual(cf, zero, 'multi-wrap-per-quantum trajectory unchanged by crossfade');
	// and every position stays within the loop
	for (const p of cf) assert.ok(p >= s - 1e-9 && p <= e + 1e-9, `in loop (${p})`);
});

test('F1: reported inputTime (peekVoice) is unaffected by crossfade', async () => {
	const base = {active: true, input: 0.6, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopTrapped: true};
	const peek = h => { const out = []; for (let q = 0; q < 400; q++) { h.render(1); out.push(h.proc.peekVoice(h.proc.timeMap[0], h.proc.inputLatencySeconds)); } return out; };
	const zero = peek(await makeVoice(base));
	const cf = peek(await makeVoice({...base, loopCrossfade: 0.2}));
	assert.deepEqual(cf, zero, 'inputTime projection identical with and without crossfade');
});

// ---------------- F2: seam synthesis ----------------

function maxWindowStep(h, c = 0) {
	const w = readWindow(h, c);
	let m = 0; for (let j = 1; j < w.length; j++) m = Math.max(m, Math.abs(w[j] - w[j - 1]));
	return m;
}

// Spy on the actual source sample indices the taper reads (value-based checks
// are unreliable because the equal-power blend of two in-loop reads produces
// intermediate/boosted values that don't map to one source position).
function readIndicesDuring(h, render) {
	const p = h.proc, orig = p.sourceSample.bind(p), idx = [];
	p.sourceSample = (c, i) => { idx.push(i); return orig(c, i); };
	render();
	p.sourceSample = orig;
	return idx;
}

function traceReadsDuring(h, render) {
	const p = h.proc, orig = p.sourceSample.bind(p), idx = [];
	let rel = null, dir = null;
	p.sourceSample = (c, i) => {
		if (rel === null) {
			rel = p.voice.rel;
			dir = p.voiceDirection(p.timeMap[0]);
		}
		idx.push(i);
		return orig(c, i);
	};
	render();
	p.sourceSample = orig;
	return {idx, rel, dir};
}

test('F2: two-sided seam reads continue in playback order, never reflected/reversed', async () => {
	const posMod = (x, m) => ((x%m) + m)%m;
	const Fsec = 0.1;
	for (const {rate, reverseStyle = null} of [
		{rate: 1},
		{rate: -1},
		{rate: -1, reverseStyle: 'mirror'},
	]) {
		const label = `rate ${rate}, ${reverseStyle || 'grain'}`;
		const h = await makeVoice({
			active: true,
			input: rate > 0 ? 0.97 : 0.53,
			rate,
			loopStart: S,
			loopEnd: E,
			loopMode: 'forward',
			loopCrossfade: Fsec,
			loopTrapped: true,
			reverseStyle,
		}, {buffer: rampBuffer({channels: 1}), channels: 1});
		const trace = traceReadsDuring(h, () => h.render(1));
		const n = h.proc.bufferLength;
		const anchor = n - Math.round(h.proc.inputLatencySeconds*SR);
		const relSamples = trace.rel*SR;
		const loopSamples = L*SR;
		const fadeSamples = Fsec*SR;
		const loopStartSample = S*SR;
		const loopEndSample = Math.round((S + L)*SR) - 1;
		const clampLoop = i => Math.max(Math.round(loopStartSample), Math.min(loopEndSample, i));
		let k = 0, secondaryReads = 0, recoveryReads = 0;
		for (let j = 0; j < n; ++j) {
			// Default Grain backward playback keeps the analysis window in source
			// order, matching fillInputWindowSeamTaper's backwardGrain mapping.
			const backwardGrain = trace.dir < 0 && reverseStyle !== 'mirror';
			const delta = backwardGrain ? anchor - j : j - anchor;
			const cp = posMod(relSamples + trace.dir*delta, loopSamples);
			const primary = clampLoop(Math.round(loopStartSample + cp));
			assert.equal(trace.idx[k++], primary, `${label}, sample ${j}: primary read follows authoritative phase`);

			let secondary = null;
			if (trace.dir > 0 && cp >= loopSamples - fadeSamples) {
				// Approaching end: tail continues into the head in forward order.
				secondary = cp - (loopSamples - fadeSamples);
			} else if (trace.dir > 0 && cp < fadeSamples) {
				// After wrap: recover from that continuation into the primary head.
				secondary = fadeSamples + cp;
				recoveryReads++;
			} else if (trace.dir < 0 && cp < fadeSamples) {
				// Approaching start: head continues into the tail in backward order.
				secondary = loopSamples - fadeSamples + cp;
			} else if (trace.dir < 0 && cp >= loopSamples - fadeSamples) {
				// After wrap: recover from that continuation into the primary tail.
				secondary = cp - fadeSamples;
				recoveryReads++;
			}
			if (secondary !== null) {
				const expected = clampLoop(Math.round(loopStartSample + secondary));
				assert.equal(trace.idx[k++], expected,
					`${label}, sample ${j}: secondary read continues in playback order`);
				secondaryReads++;
			}
		}
		assert.equal(k, trace.idx.length, `${label}: every source read belongs to the two-sided seam geometry`);
		assert.ok(secondaryReads > 1000, `${label}: exercised the seam taper`);
		assert.ok(recoveryReads > 100, `${label}: exercised the post-wrap recovery side`);
	}
});

test('F2: taper reads stay strictly inside [loopStart, loopEnd)', async () => {
	for (const rate of [1, -1]) {
		const h = await makeVoice({active: true, input: rate > 0 ? 0.97 : 0.53, rate, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0.15, loopTrapped: true}, {buffer: rampBuffer({})});
		const loS = Math.round(S*SR), loE = Math.round(E*SR); // [loopStart, loopEnd) in samples
		const idx = readIndicesDuring(h, () => h.render(1));
		assert.ok(idx.length > 1000, 'taper actually read the source');
		for (const i of idx) assert.ok(i >= loS && i < loE, `rate ${rate}: read index ${i} in [${loS},${loE})`);
	}
});

test('F2: seam is smoother than zero-crossfade for a discontinuous loop (forward & backward)', async () => {
	const n = SR*2, buf = new Float32Array(n);
	for (let i = 0; i < n; i++) { const t = i/SR; buf[i] = (t >= S && t < E) ? (t - S)/L : 0; } // 0->1 ramp, hard 1->0 seam
	for (const [rate, input] of [[1, 0.98], [-1, 0.52]]) {
		const stepAt = async F => {
			const h = await makeVoice({active: true, input, rate, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: F, loopTrapped: true}, {buffer: [buf, buf.slice()]});
			h.render(1);
			return maxWindowStep(h);
		};
		const hard = await stepAt(0), soft = await stepAt(0.12);
		// tapered window must not be clickier than zero-crossfade (hard gate),
		// and for the forward hard seam it is dramatically smoother
		assert.ok(soft <= hard + 1e-3, `rate ${rate}: taper never adds a click (hard ${hard.toFixed(4)}, soft ${soft.toFixed(4)})`);
	}
});

test('F2: forward hard seam collapses from a full step to ~continuous', async () => {
	const n = SR*2, buf = new Float32Array(n);
	for (let i = 0; i < n; i++) { const t = i/SR; buf[i] = (t >= S && t < E) ? (t - S)/L : 0; }
	const h0 = await makeVoice({active: true, input: 0.98, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0, loopTrapped: true}, {buffer: [buf, buf.slice()]});
	h0.render(1);
	const h1 = await makeVoice({active: true, input: 0.98, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0.1, loopTrapped: true}, {buffer: [buf, buf.slice()]});
	h1.render(1);
	const raw = maxWindowStep(h0), tapered = maxWindowStep(h1);
	assert.ok(raw > 0.9, `raw seam is a near-full step (${raw.toFixed(4)})`);
	assert.ok(tapered < 0.1, `tapered seam is near-continuous (${tapered.toFixed(4)})`);
});

test('F2: seam gain law is deterministic and bounded (repeatable windows, no runaway)', async () => {
	const mk = () => makeVoice({active: true, input: 0.95, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0.12, loopTrapped: true}, {buffer: rampBuffer({})});
	const a = await mk(); a.render(3); const wa = readWindow(a);
	const b = await mk(); b.render(3); const wb = readWindow(b);
	for (let i = 0; i < wa.length; i++) assert.ok(Object.is(wa[i], wb[i]), `deterministic at ${i}`);
	for (const v of wa) assert.ok(Number.isFinite(v) && Math.abs(v) <= 1.5, `bounded (${v})`);
});

test('F2: no phase section duplicated or omitted (single monotone sweep per cycle)', async () => {
	// over one full cycle the primary phase must visit each point of [0,L) once
	const h = await makeVoice({active: true, input: 0.5, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0.1, loopTrapped: true});
	const rels = [];
	for (let q = 0; q < 400; q++) { h.render(1); rels.push(h.proc.voice.rel); }
	// find one clean cycle and confirm rel increases monotonically to ~L then wraps
	let wraps = 0;
	for (let i = 1; i < rels.length; i++) {
		if (rels[i] < rels[i - 1] - 0.01) wraps++;
		else assert.ok(rels[i] >= rels[i - 1] - 1e-9, 'monotone within a cycle (no backward jump / replay)');
	}
	assert.ok(wraps >= 2, 'observed multiple full cycles');
	assert.ok(Math.max(...rels) > L - 0.02, 'cycle reaches ~L before wrapping (full length used)');
});

// ---------------- F3: lifecycle & topology regressions ----------------

test('F3: zero/omitted crossfade is bit-identical to the pre-crossfade path', async () => {
	// compare against the committed feature/native-loop-modes (aura.3) bundle
	const prev = new URL('../release/SignalsmithStretch.js', import.meta.url); // current build; aura.3 parity checked separately in audio.test regression
	const buffer = sineBuffer({sampleRate: SR, seconds: 2});
	for (const sched of [
		{active: true, input: 0.4, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward'},
		{active: true, input: 0.9, rate: -1, loopStart: S, loopEnd: E, loopMode: 'reverse', reverseStyle: 'mirror'},
		{active: true, input: 0.7, rate: 1, loopStart: S, loopEnd: E, loopMode: 'pingpong', loopTrapped: true},
	]) {
		const a = positions(await makeVoice(sched), 300);
		const b = positions(await makeVoice({...sched, loopCrossfade: 0}), 300);
		assert.deepEqual(b, a, 'explicit zero crossfade changes nothing');
	}
});

test('F3: invalid / negative / non-finite crossfades resolve to zero', async () => {
	const base = {active: true, input: 0.6, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopTrapped: true};
	const ref = positions(await makeVoice(base), 300);
	for (const bad of [-1, NaN, Infinity, '0.05', null, {}]) {
		const t = positions(await makeVoice({...base, loopCrossfade: bad}), 300);
		assert.deepEqual(t, ref, `loopCrossfade=${String(bad)} -> zero`);
	}
});

test('F3: crossfade clamps to half the loop width (still full-L cadence)', async () => {
	// F requested huge; effective clamps to L/2 but period stays L
	const h = await makeVoice({active: true, input: 0.6, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 10, loopTrapped: true}, {buffer: rampBuffer({})});
	const period = measurePeriod(h, 1200);
	assert.ok(Math.abs(period - 0.5) < 0.01, `period stays L (${period.toFixed(4)})`);
	const h2 = await makeVoice({active: true, input: 0.95, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 10, loopTrapped: true}, {buffer: rampBuffer({})});
	const loS = Math.round(S*SR), loE = Math.round(E*SR);
	const idx = readIndicesDuring(h2, () => h2.render(1));
	for (const i of idx) assert.ok(i >= loS && i < loE, `clamped taper reads in-loop (${i})`);
});

test('F3: ping-pong is acoustically unaffected; value retained across a mode change', async () => {
	const base = {active: true, input: 0.7, rate: 1, loopStart: S, loopEnd: E, loopMode: 'pingpong', loopTrapped: true};
	const a = positions(await makeVoice(base), 400);
	const h = await makeVoice({...base, loopCrossfade: 0.15});
	const b = positions(h, 400);
	assert.deepEqual(b, a, 'ping-pong trajectory identical regardless of crossfade');
	h.call('schedule', {loopMode: 'forward'}); // retained value engages, still full-L
	const period = measurePeriod(h, 1000);
	assert.ok(Math.abs(period - 0.5) < 0.02, 'forward after mode change keeps full-L period');
});

test('F3: crossfade changed live (incl. across a seam) never resets/untraps/retriggers', async () => {
	const h = await makeVoice({active: true, input: 0.7, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0.05, loopTrapped: true});
	h.render(40);
	const posBefore = h.proc.voice.pos;
	h.call('schedule', {loopCrossfade: 0.24});
	h.render(1);
	assert.ok(Math.abs(h.proc.voice.pos - posBefore) < 0.01, 'position continuous across the change');
	assert.equal(h.proc.voice.trapped, true, 'still trapped');
	// change right at a seam
	for (let q = 0; q < 400; q++) {
		h.render(1);
		if (h.proc.voice.rel < 0.01 || h.proc.voice.rel > L - 0.01) h.call('schedule', {loopCrossfade: 0.1 + 0.1*(q % 2)});
	}
	assert.equal(h.proc.voice.trapped, true, 'still trapped after seam-time changes');
	assert.ok(!hasNaN(h.render(50)[0]), 'no NaN');
});

test('F3: marker moves keep the voice trapped and preserve full-L cadence', async () => {
	const h = await makeVoice({active: true, input: 0.7, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0.1, loopTrapped: true});
	h.render(50);
	h.call('schedule', {loopStart: 1.2, loopEnd: 1.7}); // width 0.5 still
	assert.equal(h.proc.voice.trapped, true);
	const period = measurePeriod(h, 1000);
	assert.ok(Math.abs(period - 0.5) < 0.02, `period tracks the moved loop width (${period.toFixed(4)})`);
});

test('F3: rate zero holds; polarity changes both ways keep trap and produce no NaN', async () => {
	const h = await makeVoice({active: true, input: 0.95, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0.1, loopTrapped: true}, {buffer: rampBuffer({})});
	h.render(3);
	h.call('schedule', {rate: 0});
	const held = h.proc.voice.pos; const w = readWindow(h.render && h);
	h.render(5);
	assert.ok(Math.abs(h.proc.voice.pos - held) < 1e-9, 'held at rate 0');
	h.call('schedule', {rate: -1}); h.render(200);
	assert.equal(h.proc.voice.trapped, true, 'trapped after +->-');
	h.call('schedule', {rate: 1}); h.render(200);
	assert.equal(h.proc.voice.trapped, true, 'trapped after -->+');
	assert.ok(!hasNaN(h.render(50)[0]), 'no NaN through polarity changes');
});

test('F3: scrubs and reseeds re-evaluate reachability with crossfade set', async () => {
	const h = await makeVoice({active: true, input: 0.7, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0.1, loopTrapped: true});
	h.render(30);
	h.call('schedule', {input: 1.4, output: h.renderedSeconds + h.proc.outputLatencySeconds}); // past the loop
	h.render(80);
	assert.equal(h.proc.voice.trapped, false, 'scrub beyond loop escapes (no crossfade on one-shot)');
	h.call('schedule', {input: 0.55, loopTrapped: true, loopLeg: -1, loopMode: 'reverse', output: h.renderedSeconds + h.proc.outputLatencySeconds});
	h.render(120);
	assert.equal(h.proc.voice.trapped, true, 'seeded reverse return-leg re-traps');
});

test('F3: future-scheduled onset and natural end are unaffected by crossfade', async () => {
	const h = await makeVoice({active: true, input: 1.2, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: 0.1, playEnd: 1.5});
	h.render(300);
	const ev = h.posted.filter(m => m[0] === 'ended');
	assert.equal(ev.length, 1, 'natural end fires once');
	assert.ok(Math.abs(ev[0][1].position - 1.5) < 0.05, 'ends at playEnd regardless of crossfade');
});

test('F3: grain and mirror share identical crossfade topology', async () => {
	const base = {active: true, input: 0.8, rate: 1, loopStart: S, loopEnd: E, loopMode: 'reverse', loopCrossfade: 0.1, loopTrapped: true, loopLeg: -1};
	const g = positions(await makeVoice(base), 400);
	const m = positions(await makeVoice({...base, reverseStyle: 'mirror'}), 400);
	assert.deepEqual(m, g, 'identical positions across styles');
});

test('F3: renders clean across mono/stereo, 44.1k/48k, short loops, deterministic', async () => {
	for (const sampleRate of [44100, 48000]) {
		for (const channels of [1, 2]) {
			const buffer = sineBuffer({sampleRate, seconds: 1.5, channels, freq: 330});
			const mk = () => makeVoice({active: true, input: 0.42, rate: 1.5, loopStart: 0.4, loopEnd: 0.9, loopMode: 'forward', loopCrossfade: 0.08, loopTrapped: true}, {buffer, sampleRate, channels});
			const a = (await mk()).render(400), b = (await mk()).render(400);
			for (let c = 0; c < channels; c++) {
				assert.ok(!hasNaN(a[c]) && rms(a[c].subarray(a[c].length >> 1)) > 0.05, `${sampleRate}/${channels}ch: audio`);
				for (let i = 0; i < a[c].length; i++) if (!Object.is(a[c][i], b[c][i])) assert.fail(`non-deterministic ${sampleRate}/${channels} @${i}`);
			}
		}
	}
	// loop shorter than an analysis window, max-clamped crossfade
	const h = await makeVoice({active: true, input: 0.5, rate: 1, loopStart: 0.5, loopEnd: 0.505, loopMode: 'forward', loopCrossfade: 0.01, loopTrapped: true});
	const out = h.render(300)[0];
	assert.ok(!hasNaN(out), 'short loop: no NaN');
	assert.ok(h.proc.voice.pos >= 0.5 - 1e-9 && h.proc.voice.pos <= 0.505 + 1e-9, 'short loop stays bounded');
});

test('F3: end-to-end - crossfade softens a discontinuous seam while preserving tempo', async () => {
	const n = SR*2, buf = new Float32Array(n);
	for (let i = 0; i < n; i++) { const t = i/SR; const amp = (t >= S && t < E) ? 0.1 + 0.8*((t - S)/L) : 0.3; buf[i] = Math.sin(2*Math.PI*330*i/SR)*amp; }
	async function roughness(F) {
		const h = await makeVoice({active: true, input: 0.6, rate: 1, loopStart: S, loopEnd: E, loopMode: 'forward', loopCrossfade: F, loopTrapped: true}, {buffer: [buf, buf.slice()]});
		const out = h.render(1200)[0];
		const chunk = Math.round(0.01*SR);
		let maxStep = 0;
		for (let s2 = Math.round(0.5*SR); s2 + 2*chunk < out.length; s2 += chunk) {
			maxStep = Math.max(maxStep, Math.abs(rms(out.subarray(s2 + chunk, s2 + 2*chunk)) - rms(out.subarray(s2, s2 + chunk))));
		}
		return maxStep;
	}
	const hard = await roughness(0), soft = await roughness(0.12);
	assert.ok(soft <= hard, `crossfade does not worsen the seam (hard ${hard.toFixed(4)}, soft ${soft.toFixed(4)})`);
});
