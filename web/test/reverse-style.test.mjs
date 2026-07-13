// Tests for the experimental reverseStyle segment property:
//   'grain' (default, original), 'grain-clean' (|rate| time-factor), 'mirror'
import test from 'node:test';
import assert from 'node:assert/strict';
import {createProcessor, sineBuffer, rms, hasNaN} from './harness.mjs';

const SR = 48000;

// Pulse train with strongly asymmetric envelopes: instant attack, ~100ms
// exponential decay. Envelope orientation in the output tells us whether
// backward playback is grain-forward (attack first) or mirrored (swell first).
function pulseBuffer({seconds = 4, spacing = 0.5, freq = 400}) {
	const n = SR*seconds, b = new Float32Array(n);
	for (let t0 = 0.25; t0 + 0.4 < seconds; t0 += spacing) {
		const start = Math.round(t0*SR);
		let p = 0;
		for (let i = 0; i < SR*0.35; i++) {
			p += 2*Math.PI*freq/SR;
			b[start + i] += Math.sin(p)*0.8*Math.exp(-i/(SR*0.1));
		}
	}
	return [b, b.slice()];
}

async function renderReverseOneShot(reverseStyle, quanta = 1200) {
	const h = await createProcessor({sampleRate: SR});
	h.call('addBuffers', pulseBuffer({}));
	// reverse one-shot from near the end; reverseStyle opts into the loop
	// engine even with no loop bounds
	h.call('schedule', {active: true, input: 3.6, rate: -1, reverseStyle});
	return h.render(quanta)[0];
}

// For each detected click, compare energy shortly before vs after the peak
function envelopeOrientation(out) {
	const slot = Math.round(0.5*SR);
	let attackFirst = 0, swellFirst = 0;
	for (let s = Math.round(0.4*SR); s + slot < out.length; s += slot) {
		let peakI = s, peakV = 0;
		for (let i = s; i < s + slot; i++) {
			const v = Math.abs(out[i]);
			if (v > peakV) { peakV = v; peakI = i; }
		}
		if (peakV < 0.05) continue;
		const w = (from, to) => rms(out.subarray(
			Math.max(0, peakI + Math.round(from*SR)),
			Math.min(out.length, peakI + Math.round(to*SR))));
		const before = w(-0.2, -0.05), after = w(0.05, 0.2);
		if (after > before*1.5) attackFirst++;
		else if (before > after*1.5) swellFirst++;
	}
	return {attackFirst, swellFirst};
}

// NOTE: coarse output envelopes follow the *traversal* (swell into the attack)
// for every backward style - the grain/mirror difference is in fine structure.
// The measurable win of 'grain-clean' is level stability: no phase-randomised
// amplitude churn on tonal material.
test('grain-clean holds a steadier level than grain on reversed tonal material', async () => {
	async function levelChurn(reverseStyle) {
		const h = await createProcessor({sampleRate: SR});
		h.call('addBuffers', sineBuffer({sampleRate: SR, seconds: 2, freq: 330}));
		h.call('schedule', {active: true, input: 0.5, rate: 1, loopStart: 0.5, loopEnd: 1.0, loopMode: 'reverse', reverseStyle});
		const out = h.render(900)[0];
		assert.ok(!hasNaN(out), 'no NaN');
		const chunk = Math.round(0.05*SR);
		const vals = [];
		for (let s = Math.round(0.8*SR); s + chunk < out.length; s += chunk) vals.push(rms(out.subarray(s, s + chunk)));
		const mean = vals.reduce((a, b) => a + b)/vals.length;
		const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean)**2, 0)/vals.length);
		return sd/mean; // coefficient of variation
	}
	const churnGrain = await levelChurn(undefined); // default = 'grain'
	const churnClean = await levelChurn('grain-clean');
	assert.ok(churnClean < churnGrain*0.75,
		`grain-clean steadier (CV ${churnClean.toFixed(4)}) than grain (CV ${churnGrain.toFixed(4)})`);
});

test('mirror reverses envelopes: swells rise into the attack', async () => {
	const out = await renderReverseOneShot('mirror');
	assert.ok(!hasNaN(out), 'no NaN');
	const {attackFirst, swellFirst} = envelopeOrientation(out);
	assert.ok(attackFirst + swellFirst >= 4, `enough clear pulses (${attackFirst}+${swellFirst})`);
	assert.ok(swellFirst > attackFirst,
		`mirror plays swells first (swellFirst ${swellFirst} vs attackFirst ${attackFirst})`);
});

test('grain-clean and mirror renders are exactly repeatable', async () => {
	for (const style of ['grain-clean', 'mirror']) {
		const a = await renderReverseOneShot(style, 400);
		const b = await renderReverseOneShot(style, 400);
		for (let i = 0; i < a.length; i++) {
			if (!Object.is(a[i], b[i])) assert.fail(`${style}: mismatch at sample ${i}`);
		}
	}
});

test('reverseStyle does not alter loop topology positions', async () => {
	// the fill strategy is orthogonal to the position engine: identical voice
	// trajectories for every style
	async function positions(reverseStyle) {
		const h = await createProcessor({sampleRate: SR});
		h.call('addBuffers', sineBuffer({sampleRate: SR, seconds: 2}));
		h.call('schedule', {active: true, input: 0.6, rate: 1, loopStart: 0.5, loopEnd: 1.0, loopMode: 'reverse', reverseStyle});
		const traj = [];
		for (let q = 0; q < 300; q++) { h.render(1); traj.push(h.proc.voice.pos); }
		return traj;
	}
	const [g, gc, m] = await Promise.all([positions(undefined), positions('grain-clean'), positions('mirror')]);
	assert.deepEqual(gc, g, 'grain-clean positions match default');
	assert.deepEqual(m, g, 'mirror positions match default');
});

test('mirror renders continuously across reverse-loop seams', async () => {
	const h = await createProcessor({sampleRate: SR});
	h.call('addBuffers', sineBuffer({sampleRate: SR, seconds: 2, freq: 330}));
	h.call('schedule', {active: true, input: 0.5, rate: 1.5, loopStart: 0.5, loopEnd: 0.8, loopMode: 'reverse', reverseStyle: 'mirror'});
	const out = h.render(800)[0];
	assert.ok(!hasNaN(out), 'no NaN');
	const chunk = Math.round(0.05*SR);
	for (let s = Math.round(0.4*SR); s + chunk < out.length; s += chunk) {
		const r = rms(out.subarray(s, s + chunk));
		assert.ok(r > 0.05, `no dropout at ${(s/SR).toFixed(2)}s (rms ${r.toFixed(4)})`);
	}
});

test('invalid reverseStyle values fall back to default behaviour', async () => {
	const h = await createProcessor({sampleRate: SR});
	h.call('addBuffers', sineBuffer({sampleRate: SR, seconds: 2}));
	h.call('schedule', {active: true, input: 0.6, rate: -1, loopStart: 0.5, loopEnd: 1.0, loopMode: 'forward', reverseStyle: 'bogus'});
	const out = h.render(300)[0];
	assert.ok(!hasNaN(out) && rms(out.subarray(out.length >> 1)) > 0.05, 'renders with default style');
});
