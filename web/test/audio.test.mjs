// Audio-level tests: legacy bit-exactness vs the upstream wrapper, render
// repeatability, channel/sample-rate coverage, audible topology, seam
// continuity and spectral hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import {execFileSync} from 'node:child_process';
import {createProcessor, sineBuffer, splitFreqBuffer, dominantFreq, rms, maxAbs, hasNaN, QUANTUM} from './harness.mjs';

const dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.join(dirname, '../..');

const SR = 48000;

// Rebuild the pre-fork bundle in-memory: current WASM (emscripten/main.js is
// unchanged by this branch) + the upstream wrapper. Isolates wrapper changes.
function upstreamBundlePath() {
	let wrapper;
	try {
		wrapper = execFileSync('git', ['-C', repoRoot, 'show', 'upstream/main:web/web-wrapper.js'], {encoding: 'utf8'});
	} catch (e) {
		return null; // upstream remote not available: caller skips
	}
	const mainJs = fs.readFileSync(path.join(repoRoot, 'web/emscripten/main.js'), 'utf8');
	const out = path.join(os.tmpdir(), 'signalsmith-baseline-bundle.js');
	fs.writeFileSync(out, mainJs + wrapper);
	return out;
}

// Assert two Float32Array renders are bit-identical (fast, precise diagnostics)
function assertSameAudio(got, want, label) {
	assert.equal(got.length, want.length, `${label}: length`);
	for (let i = 0; i < got.length; i++) {
		if (!Object.is(got[i], want[i])) {
			assert.fail(`${label}: first mismatch at sample ${i} (${(i/SR).toFixed(4)}s): ${got[i]} != ${want[i]}`);
		}
	}
}

async function renderSchedule({bundlePath, sampleRate = SR, channels = 2, buffer, schedules, quanta}) {
	const h = await createProcessor({bundlePath, sampleRate, channels});
	h.call('addBuffers', buffer);
	for (const s of schedules) h.call('schedule', s);
	return {h, out: h.render(quanta)};
}

const LEGACY_SCHEDULES = [
	// classic positive-rate forward loop, no loopMode anywhere
	[{active: true, input: 0.1, rate: 1, loopStart: 0.5, loopEnd: 1.0, output: 0}],
	// negative-rate one-shot with a scrub
	[{active: true, input: 1.5, rate: -1, output: 0}, {input: 0.2, rate: 0.5, outputTime: 0.5}],
	// rate zero hold
	[{active: true, input: 0.5, rate: 1, output: 0}, {rate: 0, outputTime: 0.4}, {rate: 1, outputTime: 0.8}],
];

test('consumers without loopMode get bit-identical output to the upstream wrapper', async () => {
	const baseline = upstreamBundlePath();
	if (!baseline) return test.skip('upstream remote unavailable');
	const buffer = sineBuffer({sampleRate: SR, seconds: 2});
	for (const schedules of LEGACY_SCHEDULES) {
		const a = await renderSchedule({bundlePath: baseline, buffer, schedules, quanta: 500});
		const b = await renderSchedule({buffer, schedules, quanta: 500});
		for (let c = 0; c < 2; c++) {
			assertSameAudio(b.out[c], a.out[c], `legacy channel ${c} (${JSON.stringify(schedules[0])})`);
		}
	}
});

const MODES = ['forward', 'reverse', 'pingpong'];

test('renders are exactly repeatable in every mode (with a live polarity flip)', async () => {
	const buffer = sineBuffer({sampleRate: SR, seconds: 2});
	for (const loopMode of MODES) {
		const schedules = [
			{active: true, input: 0.4, rate: 1, loopStart: 0.5, loopEnd: 1.0, loopMode, output: 0},
			{rate: -1, outputTime: 0.9}, // scheduled polarity flip
		];
		const a = await renderSchedule({buffer, schedules, quanta: 600});
		const b = await renderSchedule({buffer, schedules, quanta: 600});
		assertSameAudio(b.out[0], a.out[0], `${loopMode}: repeatable render`);
	}
});

test('mono and stereo buffers render cleanly at 44.1kHz and 48kHz in every mode', async () => {
	for (const sampleRate of [44100, 48000]) {
		for (const channels of [1, 2]) {
			for (const loopMode of MODES) {
				const buffer = sineBuffer({sampleRate, seconds: 1.5, channels});
				const {out} = await renderSchedule({
					sampleRate, channels, buffer,
					schedules: [{active: true, input: 0.3, rate: 1, loopStart: 0.4, loopEnd: 0.9, loopMode, output: 0}],
					quanta: 400,
				});
				for (let c = 0; c < channels; c++) {
					assert.ok(!hasNaN(out[c]), `${loopMode} ${sampleRate}Hz ${channels}ch: no NaN`);
					assert.ok(rms(out[c].subarray(out[c].length >> 1)) > 0.05,
						`${loopMode} ${sampleRate}Hz ${channels}ch: sustained energy`);
					assert.ok(maxAbs(out[c]) < 1.5, `${loopMode} ${sampleRate}Hz ${channels}ch: no blowup`);
				}
			}
		}
	}
});

// Audible topology: buffer is 220Hz in [0,1)s and 880Hz in [1,2)s; the loop
// spans both. The sequence of dominant frequencies tells us which leg is
// audibly playing, independent of any internal position bookkeeping.
test('audible leg sequence matches each topology', async () => {
	const buffer = splitFreqBuffer({sampleRate: SR, seconds: 2, freqA: 220, freqB: 880});
	// legs are 0.5s each within loop [0.5, 1.5]; A = [0.5,1.0), B = [1.0,1.5)
	const cases = {
		// forward, +1: A B A B A B ...
		forward: 'ABABABAB',
		// reverse, +1 from 0.5: approach A B, turn at end, backward B A, wrap: B A ...
		reverse: 'ABBABABA',
		// pingpong, +1 from 0.5: A B reflect B A reflect A B ...
		pingpong: 'ABBAABBA',
	};
	for (const [loopMode, expected] of Object.entries(cases)) {
		const {h, out} = await renderSchedule({
			buffer,
			schedules: [{active: true, input: 0.5, rate: 1, loopStart: 0.5, loopEnd: 1.5, loopMode, output: 0}],
			quanta: Math.ceil(expected.length*0.5*SR/QUANTUM) + 100,
		});
		const latency = h.proc.outputLatencySeconds;
		let got = '';
		for (let leg = 0; leg < expected.length; leg++) {
			// sample the middle 0.2s of each 0.5s leg, shifted by output latency
			const mid = latency + leg*0.5 + 0.25;
			const from = Math.round((mid - 0.1)*SR), to = Math.round((mid + 0.1)*SR);
			const f = dominantFreq(out[0].subarray(from, to), SR);
			got += (Math.abs(f - 220) < Math.abs(f - 880)) ? 'A' : 'B';
		}
		assert.equal(got, expected, `${loopMode}: audible sequence`);
	}
});

test('no gaps, clicks blowups or NaN across many seams in every mode', async () => {
	const buffer = sineBuffer({sampleRate: SR, seconds: 2, freq: 330});
	for (const loopMode of MODES) {
		// short loop: ~6 seams per second at rate 2
		const {out} = await renderSchedule({
			buffer,
			schedules: [{active: true, input: 0.5, rate: 2, loopStart: 0.5, loopEnd: 0.8, loopMode, output: 0}],
			quanta: 800,
		});
		const chunk = Math.round(0.05*SR);
		// reverse-direction synthesis is phase-randomised upstream and its level
		// fluctuates on pure tones (measurably less than the shipped legacy
		// reverse); allow deeper dips there without calling them gaps
		const floor = (loopMode === 'reverse') ? 0.03 : 0.08;
		for (let start = Math.round(0.3*SR); start + chunk < out[0].length; start += chunk) {
			const c = out[0].subarray(start, start + chunk);
			assert.ok(!hasNaN(c), `${loopMode}: no NaN`);
			const r = rms(c);
			assert.ok(r > floor, `${loopMode}: no dropout at ${(start/SR).toFixed(2)}s (rms ${r.toFixed(4)})`);
			assert.ok(maxAbs(c) < 1.5, `${loopMode}: no blowup at ${(start/SR).toFixed(2)}s`);
		}
	}
});

test('rate zero holds audible spectrum inside the loop, then resumes', async () => {
	const buffer = sineBuffer({sampleRate: SR, seconds: 2, freq: 440});
	const {out} = await renderSchedule({
		buffer,
		schedules: [
			{active: true, input: 0.5, rate: 1, loopStart: 0.5, loopEnd: 1.0, loopMode: 'pingpong', output: 0},
			{rate: 0, outputTime: 0.5},
			{rate: -1, outputTime: 1.2},
		],
		quanta: 800,
	});
	// during the hold (0.6..1.1s output time) the spectral hold keeps sounding
	for (let t = 0.6; t < 1.1; t += 0.1) {
		const c = out[0].subarray(Math.round(t*SR), Math.round((t + 0.09)*SR));
		assert.ok(rms(c) > 0.05, `spectral hold audible at ${t.toFixed(1)}s (rms ${rms(c).toFixed(4)})`);
		const f = dominantFreq(c, SR);
		assert.ok(Math.abs(f - 440) < 60, `hold keeps the source pitch (got ${f.toFixed(0)}Hz)`);
	}
	// after resume it keeps playing
	const tail = out[0].subarray(Math.round(1.6*SR));
	assert.ok(rms(tail) > 0.05, 'resumed playback after the hold');
});

test('dropBuffers survives channels sharing one ArrayBuffer (duplicate transfer regression)', async () => {
	// same Float32Array for both channels: structured clone preserves identity,
	// so the worklet's channels share one ArrayBuffer; dropBuffers must not put
	// it in the transfer list twice (browsers throw DataCloneError)
	const h = await createProcessor({sampleRate: SR});
	const mono = sineBuffer({sampleRate: SR, seconds: 0.5, channels: 1})[0];
	h.call('addBuffers', [mono, mono]);
	h.call('dropBuffers'); // full drop path
	h.call('addBuffers', [mono, mono]);
	h.call('dropBuffers', 0.5); // partial drop path
	// still renders cleanly afterwards
	h.call('addBuffers', sineBuffer({sampleRate: SR, seconds: 1}));
	h.call('schedule', {active: true, input: 0, rate: 1, loopStart: 0.2, loopEnd: 0.6, loopMode: 'forward', output: 0});
	const out = h.render(300)[0];
	assert.ok(!hasNaN(out) && rms(out.subarray(out.length >> 1)) > 0.05, 'renders after shared-buffer drops');
});

test('pitch shift and loop modes combine (semitones stay applied across seams)', async () => {
	const buffer = sineBuffer({sampleRate: SR, seconds: 2, freq: 220});
	const {out} = await renderSchedule({
		buffer,
		schedules: [{active: true, input: 0.5, rate: 1, loopStart: 0.5, loopEnd: 0.9, loopMode: 'reverse', semitones: 12, output: 0}],
		quanta: 700,
	});
	const c = out[0].subarray(Math.round(1.0*SR), Math.round(1.4*SR));
	const f = dominantFreq(c, SR);
	assert.ok(Math.abs(f - 440) < 60, `+12 semitones across reverse seams (got ${f.toFixed(0)}Hz)`);
});
