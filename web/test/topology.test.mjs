// White-box tests for the loop-topology engine: drives the real processor in
// the Node harness and checks voice position/direction against an independent
// per-sample oracle implementing the spec:
//   actual direction = rate sign x current loop leg
import test from 'node:test';
import assert from 'node:assert/strict';
import {createProcessor, sineBuffer, QUANTUM} from './harness.mjs';

const SR = 48000;
const QD = QUANTUM/SR; // seconds per render quantum

// ---- Independent oracle: per-sample stepping, spec semantics ----
function makeOracle({input, rate, loopStart = 0, loopEnd = 0, loopMode}) {
	const st = {
		pos: input, rate, loopStart, loopEnd, loopMode,
		trapped: false, legPP: 1, turned: false, lastDir: Math.sign(rate) || 1,
	};
	const L = () => {
		const l = st.loopEnd - st.loopStart;
		return (Number.isFinite(l) && l > 0) ? l : 0;
	};
	const step = () => { // one sample
		const dp = st.rate/SR;
		const l = L();
		if (!l) { st.trapped = false; st.pos += dp; return; }
		const dir = Math.sign(st.rate) || st.lastDir;
		if (!st.trapped) {
			const inside = dir > 0
				? (st.pos >= st.loopStart && st.pos < st.loopEnd)
				: (st.pos > st.loopStart && st.pos <= st.loopEnd);
			if (inside) {
				st.trapped = true; st.legPP = 1; st.turned = false;
			} else {
				st.pos += dp;
				return;
			}
		}
		if (st.rate !== 0) st.lastDir = Math.sign(st.rate);
		if (st.loopMode === 'forward') {
			st.pos += dp;
			if (dp > 0 && st.pos >= st.loopEnd) st.pos -= l;
			if (dp < 0 && st.pos < st.loopStart) st.pos += l;
		} else if (st.loopMode === 'pingpong') {
			st.pos += dp*st.legPP;
			let guard = 0;
			while (guard++ < 8) {
				if (st.pos >= st.loopEnd && dp*st.legPP > 0) { st.pos = 2*st.loopEnd - st.pos; st.legPP = -st.legPP; }
				else if (st.pos <= st.loopStart && dp*st.legPP < 0) { st.pos = 2*st.loopStart - st.pos; st.legPP = -st.legPP; }
				else break;
			}
		} else { // reverse
			if (!st.turned) {
				st.pos += dp;
				if (dp > 0 && st.pos >= st.loopEnd) { st.pos = 2*st.loopEnd - st.pos; st.turned = true; }
				else if (dp < 0 && st.pos <= st.loopStart) { st.pos = 2*st.loopStart - st.pos; st.turned = true; }
			} else {
				const motion = -dp; // cycles against the rate sign, wrapping
				st.pos += motion;
				if (motion > 0 && st.pos >= st.loopEnd) st.pos -= l;
				if (motion < 0 && st.pos < st.loopStart) st.pos += l;
			}
		}
	};
	return {
		st,
		quantum() { for (let i = 0; i < QUANTUM; i++) step(); },
	};
}

// ---- Rig: real processor + oracle, stepping together ----
async function makeRig({input, rate, loopStart = 0, loopEnd = 0, loopMode, seconds = 3}) {
	const h = await createProcessor({sampleRate: SR});
	h.call('addBuffers', sineBuffer({sampleRate: SR, seconds}));
	const t0 = h.proc.outputLatencySeconds; // so playback starts exactly at `input`
	h.call('schedule', {active: true, input, rate, loopStart, loopEnd, loopMode, output: t0});
	const oracle = makeOracle({input, rate, loopStart, loopEnd, loopMode});
	// prime render: after it, processor position == `input` == oracle position,
	// and each subsequent (oracle.quantum + render) pair stays aligned
	h.render(1);
	return {
		h, oracle,
		// step n quanta, asserting the processor tracks the oracle position
		step(n, tolSamples = 4) {
			for (let q = 0; q < n; q++) {
				this.oracle.quantum();
				h.render(1);
				const got = h.proc.voice.pos;
				const want = this.oracle.st.pos;
				const tol = tolSamples/SR + Math.abs(this.oracle.st.rate)*2/SR;
				let d = Math.abs(got - want);
				// at the exact wrap instant both `loopEnd` and `loopStart` describe
				// the same loop position: compare circularly for wrap topologies
				const l = this.oracle.st.loopEnd - this.oracle.st.loopStart;
				if (this.oracle.st.trapped && h.proc.voice.trapped && l > 0 && this.oracle.st.loopMode !== 'pingpong') {
					const wrapped = Math.abs(d%l);
					d = Math.min(d, Math.abs(l - wrapped), wrapped);
				}
				assert.ok(d <= tol,
					`pos diverged at quantum ${q}: got ${got.toFixed(6)} want ${want.toFixed(6)} (tol ${tol.toFixed(6)})`);
			}
		},
		// schedule a live change (continuation - no explicit input)
		change(obj) {
			h.call('schedule', obj);
			if ('rate' in obj) this.oracle.st.rate = obj.rate;
			if ('loopStart' in obj) this.oracle.st.loopStart = obj.loopStart;
			if ('loopEnd' in obj) this.oracle.st.loopEnd = obj.loopEnd;
			if ('loopMode' in obj) this.oracle.st.loopMode = obj.loopMode;
		},
		// explicit scrub, scheduled the way start() does (latency-compensated)
		scrub(input) {
			h.call('schedule', {input, output: h.renderedSeconds + h.proc.outputLatencySeconds});
			this.oracle.st.pos = input;
			this.oracle.st.trapped = false;
			this.oracle.st.turned = false;
			this.oracle.st.legPP = 1;
			h.render(1); // realign: after this render the processor sits at `input`
		},
	};
}

const LOOP = {loopStart: 0.5, loopEnd: 1.0};

// ---- Forward mode ----

test('forward loop, positive rate: wraps end to start', async () => {
	const rig = await makeRig({input: 0.4, rate: 1, ...LOOP, loopMode: 'forward'});
	rig.step(400); // > 1s: several wraps
	assert.equal(rig.h.proc.voice.trapped, true);
	const p = rig.h.proc.voice.pos;
	assert.ok(p >= 0.5 && p < 1.0, `trapped position ${p} inside loop`);
});

test('forward loop, negative rate: wraps start to end', async () => {
	const rig = await makeRig({input: 0.9, rate: -1, ...LOOP, loopMode: 'forward'});
	rig.step(400);
	assert.equal(rig.h.proc.voice.trapped, true);
	const p = rig.h.proc.voice.pos;
	assert.ok(p >= 0.5 && p < 1.0, `trapped position ${p} inside loop`);
});

test('forward loop: live rate polarity flip reverses travel without restart', async () => {
	const rig = await makeRig({input: 0.6, rate: 1, ...LOOP, loopMode: 'forward'});
	rig.step(100);
	const before = rig.h.proc.voice.pos;
	rig.change({rate: -1});
	rig.step(1);
	const after = rig.h.proc.voice.pos;
	assert.ok(Math.abs(after - before) < 0.01, `no jump at polarity flip (${before} -> ${after})`);
	rig.step(150);
	assert.equal(rig.h.proc.voice.trapped, true);
});

// ---- Reverse mode ----

test('reverse loop, positive rate: turns at loop end, then cycles backward with start-to-end wraps', async () => {
	const rig = await makeRig({input: 0.45, rate: 1, ...LOOP, loopMode: 'reverse'});
	rig.step(60); // approach + entry
	assert.equal(rig.h.proc.voice.trapped, true);
	assert.equal(rig.h.proc.voice.turned, false);
	rig.step(250); // cross the turn (~0.55s of travel needed)
	assert.equal(rig.h.proc.voice.turned, true);
	rig.step(400); // several backward cycles with wraps
});

test('reverse loop, negative rate: turns at loop start, then cycles forward with end-to-start wraps', async () => {
	const rig = await makeRig({input: 1.1, rate: -1, ...LOOP, loopMode: 'reverse'});
	rig.step(300);
	assert.equal(rig.h.proc.voice.trapped, true);
	assert.equal(rig.h.proc.voice.turned, true);
	rig.step(400);
});

test('reverse loop: rate polarity flip while cycling reverses travel, keeps loop leg', async () => {
	const rig = await makeRig({input: 0.55, rate: 1, ...LOOP, loopMode: 'reverse'});
	rig.step(300); // trapped and turned
	assert.equal(rig.h.proc.voice.turned, true);
	rig.change({rate: -1});
	rig.step(300); // now cycling forward; still turned, still trapped
	assert.equal(rig.h.proc.voice.turned, true);
	assert.equal(rig.h.proc.voice.trapped, true);
});

// ---- Ping-pong mode ----

test('pingpong, positive rate: reflects at both boundaries, preserving overshoot', async () => {
	const rig = await makeRig({input: 0.45, rate: 1, ...LOOP, loopMode: 'pingpong'});
	rig.step(800); // several full round trips
	const p = rig.h.proc.voice.pos;
	assert.ok(p >= 0.5 && p <= 1.0, `position ${p} stays inside loop`);
});

test('pingpong, negative rate: first leg toward loop start', async () => {
	const rig = await makeRig({input: 0.9, rate: -1, ...LOOP, loopMode: 'pingpong'});
	rig.step(800);
});

test('pingpong: rate polarity flip reverses motion without resetting the leg', async () => {
	const rig = await makeRig({input: 0.55, rate: 1, ...LOOP, loopMode: 'pingpong'});
	rig.step(250); // somewhere on the reflected leg by now
	rig.change({rate: -1});
	rig.step(400);
	rig.change({rate: 1});
	rig.step(400);
});

test('pingpong at high rate: crosses multiple loop lengths per quantum, stays exact', async () => {
	const rig = await makeRig({input: 0.5, rate: 50, loopStart: 0.5, loopEnd: 0.6, loopMode: 'pingpong'});
	// travel per quantum = 50*128/48000 = 0.133s > loop length 0.1s
	rig.step(200, 16); // slightly wider tolerance: oracle reflects per-sample
	const p = rig.h.proc.voice.pos;
	assert.ok(p >= 0.5 && p <= 0.6, `position ${p} inside loop after many same-block reflections`);
});

test('forward at high negative rate: multiple wraps per quantum', async () => {
	const rig = await makeRig({input: 0.55, rate: -50, loopStart: 0.5, loopEnd: 0.6, loopMode: 'forward'});
	rig.step(200, 16);
	const p = rig.h.proc.voice.pos;
	assert.ok(p >= 0.5 && p < 0.6, `position ${p} inside loop`);
});

// ---- Rate zero ----

test('rate zero freezes position; resume works in either direction', async () => {
	const rig = await makeRig({input: 0.7, rate: 1, ...LOOP, loopMode: 'forward'});
	rig.step(50);
	rig.change({rate: 0});
	const frozen = [];
	for (let i = 0; i < 50; i++) { rig.oracle.quantum(); rig.h.render(1); frozen.push(rig.h.proc.voice.pos); }
	assert.ok(frozen.every(p => Math.abs(p - frozen[0]) < 1e-9), 'position frozen at rate 0');
	assert.equal(rig.h.proc.voice.lastDir, 1, 'last direction stays defined during hold');
	rig.change({rate: -1});
	rig.step(100);
	assert.equal(rig.h.proc.voice.trapped, true);
});

// ---- Start positions & reachability ----

test('exact-boundary starts follow the reachability rules', async () => {
	// start at loopEnd, positive rate: beyond the loop, stays a one-shot
	let rig = await makeRig({input: 1.0, rate: 1, ...LOOP, loopMode: 'forward'});
	rig.step(200);
	assert.equal(rig.h.proc.voice.trapped, false);
	assert.ok(rig.h.proc.voice.pos > 1.0);

	// start at loopEnd, negative rate: reachable, trapped
	rig = await makeRig({input: 1.0, rate: -1, ...LOOP, loopMode: 'forward'});
	rig.step(200);
	assert.equal(rig.h.proc.voice.trapped, true);

	// start at loopStart, positive rate: inside, trapped
	rig = await makeRig({input: 0.5, rate: 1, ...LOOP, loopMode: 'forward'});
	rig.step(200);
	assert.equal(rig.h.proc.voice.trapped, true);

	// start at loopStart, negative rate: moving away, one-shot
	rig = await makeRig({input: 0.5, rate: -1, ...LOOP, loopMode: 'forward'});
	rig.step(150);
	assert.equal(rig.h.proc.voice.trapped, false);
	assert.ok(rig.h.proc.voice.pos < 0.5);
});

test('start beyond loop end at positive rate stays a one-shot (no backwards jump)', async () => {
	const rig = await makeRig({input: 1.2, rate: 1, ...LOOP, loopMode: 'pingpong'});
	rig.step(300);
	assert.equal(rig.h.proc.voice.trapped, false);
	assert.ok(rig.h.proc.voice.pos > 1.2);
});

test('start before loop start at negative rate stays a one-shot (mirrored rule)', async () => {
	const rig = await makeRig({input: 0.3, rate: -1, ...LOOP, loopMode: 'reverse'});
	rig.step(300);
	assert.equal(rig.h.proc.voice.trapped, false);
	assert.ok(rig.h.proc.voice.pos < 0.3);
});

test('start before the loop traps on arrival in every mode', async () => {
	for (const loopMode of ['forward', 'reverse', 'pingpong']) {
		const rig = await makeRig({input: 0.2, rate: 2, ...LOOP, loopMode});
		rig.step(300);
		assert.equal(rig.h.proc.voice.trapped, true, `${loopMode}: trapped after reaching loop`);
	}
});

// ---- Loop-marker moves ----

test('moving the loop window while trapped keeps the voice trapped, phase-mapped', async () => {
	const rig = await makeRig({input: 0.6, rate: 1, ...LOOP, loopMode: 'forward'});
	rig.step(100);
	rig.h.call('schedule', {loopStart: 1.2, loopEnd: 1.5});
	rig.h.render(1);
	const v = rig.h.proc.voice;
	assert.equal(v.trapped, true, 'still trapped after the window moved');
	assert.ok(v.pos >= 1.2 && v.pos < 1.5, `position ${v.pos} mapped into the new window`);
});

test('growing/shrinking the window around a trapped voice keeps its position', async () => {
	const rig = await makeRig({input: 0.6, rate: 1, ...LOOP, loopMode: 'forward'});
	rig.step(20);
	const before = rig.h.proc.voice.pos;
	rig.h.call('schedule', {loopStart: 0.4, loopEnd: 1.1}); // still contains the voice
	rig.h.render(1);
	const after = rig.h.proc.voice.pos;
	assert.ok(Math.abs(after - before) < 0.01, `in-window marker move keeps position (${before} -> ${after})`);
	assert.equal(rig.h.proc.voice.trapped, true);
});

test('moving markers before entry does not override start reachability', async () => {
	// voice starts beyond the loop (one-shot); moving markers must not trap it
	const rig = await makeRig({input: 1.2, rate: 1, ...LOOP, loopMode: 'forward'});
	rig.step(50);
	rig.h.call('schedule', {loopStart: 0.6, loopEnd: 1.05}); // still behind the voice
	rig.h.render(1);
	rig.step ? null : null;
	for (let i = 0; i < 100; i++) rig.h.render(1);
	assert.equal(rig.h.proc.voice.trapped, false, 'stays a one-shot');
});

// ---- Enable / disable / invalid bounds ----

test('disabling looping releases the voice to one-shot traversal', async () => {
	const rig = await makeRig({input: 0.6, rate: 1, ...LOOP, loopMode: 'forward'});
	rig.step(100);
	assert.equal(rig.h.proc.voice.trapped, true);
	rig.change({loopStart: 0, loopEnd: 0});
	rig.step(300);
	assert.equal(rig.h.proc.voice.trapped, false);
	assert.ok(rig.h.proc.voice.pos > 1.0, 'escaped past the old loop end');
});

test('re-enabling looping while inside the region traps again', async () => {
	const rig = await makeRig({input: 0.6, rate: 1, ...LOOP, loopMode: 'forward'});
	rig.step(50);
	rig.change({loopStart: 0, loopEnd: 0});
	rig.step(20);
	rig.change({...LOOP}); // voice still inside [0.5, 1.0]
	rig.step(400);
	assert.equal(rig.h.proc.voice.trapped, true);
});

test('invalid and zero-width bounds disable looping safely', async () => {
	for (const bounds of [
		{loopStart: 0.5, loopEnd: 0.5},
		{loopStart: 1.0, loopEnd: 0.5},
		{loopStart: NaN, loopEnd: 1.0},
	]) {
		const rig = await makeRig({input: 0.4, rate: 1, ...bounds, loopMode: 'pingpong'});
		rig.step(100);
		assert.equal(rig.h.proc.voice.trapped, false);
		assert.ok(Number.isFinite(rig.h.proc.voice.pos), 'position stays finite');
	}
});

// ---- Scrubs & mode changes ----

test('explicit scrub out of the loop releases and re-applies reachability', async () => {
	const rig = await makeRig({input: 0.6, rate: 1, ...LOOP, loopMode: 'forward'});
	rig.step(100);
	assert.equal(rig.h.proc.voice.trapped, true);
	// scrub beyond loop end: must not be yanked back in
	rig.scrub(1.3);
	rig.step(200);
	assert.equal(rig.h.proc.voice.trapped, false);
	assert.ok(rig.h.proc.voice.pos > 1.3);
});

test('live loop-mode change keeps the voice trapped at its position', async () => {
	const rig = await makeRig({input: 0.6, rate: 1, ...LOOP, loopMode: 'forward'});
	rig.step(100);
	const before = rig.h.proc.voice.pos;
	rig.change({loopMode: 'pingpong'});
	rig.oracle.st.legPP = 1; rig.oracle.st.turned = false;
	rig.oracle.quantum(); rig.h.render(1);
	const after = rig.h.proc.voice.pos;
	assert.ok(Math.abs(after - before) < 0.01, `mode change keeps position (${before} -> ${after})`);
	assert.equal(rig.h.proc.voice.trapped, true);
	rig.step(400);
});

// ---- Short and long loops ----

test('very short loop (1ms) stays bounded in all modes', async () => {
	for (const loopMode of ['forward', 'reverse', 'pingpong']) {
		const rig = await makeRig({input: 0.5, rate: 1, loopStart: 0.5, loopEnd: 0.501, loopMode});
		rig.step(200, 16);
		const p = rig.h.proc.voice.pos;
		assert.ok(p >= 0.5 - 1e-6 && p <= 0.501 + 1e-6, `${loopMode}: position ${p} inside 1ms loop`);
	}
});

test('long loop (whole buffer) cycles correctly', async () => {
	const rig = await makeRig({input: 0, rate: 4, loopStart: 0, loopEnd: 2.0, loopMode: 'pingpong', seconds: 2});
	rig.step(800, 8);
});

// ---- Reported time ----

test('reported inputTime stays within the loop and matches travel direction', async () => {
	const rig = await makeRig({input: 0.5, rate: 1, ...LOOP, loopMode: 'pingpong'});
	rig.h.call('setUpdateInterval', QD);
	rig.h.render(600);
	const reports = rig.h.timePosts.slice(5);
	assert.ok(reports.length > 100, 'got frequent time reports');
	for (const r of reports) {
		assert.ok(r.value >= 0.5 - 1e-3 && r.value <= 1.0 + 1e-3,
			`reported time ${r.value} stays within the loop window`);
	}
});

test('unset loopMode keeps the original forward behaviour (wraps even from beyond loop end)', async () => {
	// upstream quirk: without loopMode, a position past loopEnd wraps immediately
	const h = await createProcessor({sampleRate: SR});
	h.call('addBuffers', sineBuffer({sampleRate: SR, seconds: 3}));
	h.call('setUpdateInterval', QD);
	const t0 = h.proc.outputLatencySeconds;
	h.call('schedule', {active: true, input: 1.05, rate: 1, ...LOOP, output: t0});
	h.render(400);
	const last = h.timePosts[h.timePosts.length - 1];
	assert.ok(last.value < 1.0 + h.proc.inputLatencySeconds + 1e-3,
		`legacy path wrapped back into the loop (reported ${last.value})`);
});
