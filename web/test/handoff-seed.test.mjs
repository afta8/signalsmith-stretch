// Onset loop-state seeding for engine handoffs: an explicit-input schedule can
// carry loopTrapped / loopLeg / lastDirection to continue existing topology
// state instead of resetting to untrapped reachability evaluation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createProcessor, sineBuffer} from './harness.mjs';

const SR = 48000;
const LOOP = {loopStart: 0.5, loopEnd: 1.0};

async function seeded(schedule) {
	const h = await createProcessor({sampleRate: SR});
	h.call('addBuffers', sineBuffer({sampleRate: SR, seconds: 2}));
	h.call('schedule', schedule);
	return h;
}

function trajectory(h, quanta) {
	const t = [];
	for (let q = 0; q < quanta; q++) { h.render(1); t.push(h.proc.voice.pos); }
	return t;
}

test('seeded reverse return-leg travels against the rate sign immediately', async () => {
	// unseeded, a reverse voice at +rate first approaches loop end; seeded on
	// the return leg it must cycle backward from the very first block
	const h = await seeded({active: true, input: 0.8, rate: 1, ...LOOP, loopMode: 'reverse', loopTrapped: true, loopLeg: -1});
	assert.equal(h.proc.voice.trapped, false, 'not synced until first render');
	const t = trajectory(h, 200);
	assert.equal(h.proc.voice.trapped, true);
	assert.equal(h.proc.voice.turned, true, 'seeded as already turned');
	assert.ok(t[10] < 0.8 && t[10] > t[20], 'moving backward immediately');
	// wraps start -> end while cycling
	assert.ok(t.some((p, i) => i > 0 && p - t[i - 1] > 0.3), 'wrapped start to end');
});

test('seeded reverse first-leg matches unseeded approach behaviour', async () => {
	const a = await seeded({active: true, input: 0.7, rate: 1, ...LOOP, loopMode: 'reverse', loopTrapped: true, loopLeg: 1});
	const b = await seeded({active: true, input: 0.7, rate: 1, ...LOOP, loopMode: 'reverse'});
	assert.deepEqual(trajectory(a, 300), trajectory(b, 300), 'identical trajectories');
});

test('seeded pingpong return-leg reflects at loop start, preserving the leg model', async () => {
	const h = await seeded({active: true, input: 0.7, rate: 1, ...LOOP, loopMode: 'pingpong', loopTrapped: true, loopLeg: -1});
	const t = trajectory(h, 300);
	assert.ok(t[10] < 0.7, 'return leg: moving toward loop start despite +rate');
	const min = Math.min(...t);
	assert.ok(min >= 0.5 - 1e-6, 'reflected at loop start, never escaped');
	assert.ok(t[t.length - 1] > min + 0.05, 'travelling forward again after the reflection');
});

test('seeded pingpong at negative rate: leg -1 travels forward (rate sign x leg)', async () => {
	const h = await seeded({active: true, input: 0.7, rate: -1, ...LOOP, loopMode: 'pingpong', loopTrapped: true, loopLeg: -1});
	const t = trajectory(h, 100);
	assert.ok(t[20] > 0.7, 'direction = (-1) x (-1) = forward');
});

test('seeded forward voice outside the window phase-maps in (no one-shot escape)', async () => {
	// unseeded, input 1.2 at +rate past loopEnd is an unreachable one-shot;
	// seeded trapped it must continue looping
	const h = await seeded({active: true, input: 1.2, rate: 1, ...LOOP, loopMode: 'forward', loopTrapped: true});
	trajectory(h, 400);
	assert.equal(h.proc.voice.trapped, true);
	const p = h.proc.voice.pos;
	assert.ok(p >= 0.5 && p < 1.0, `stays inside the loop (${p.toFixed(3)})`);
});

test('rate-zero handoff: seeded state holds, lastDirection defines orientation, resume works', async () => {
	const h = await seeded({active: true, input: 0.75, rate: 0, ...LOOP, loopMode: 'pingpong', loopTrapped: true, loopLeg: -1, lastDirection: -1});
	const t = trajectory(h, 100);
	assert.ok(t.every(p => Math.abs(p - 0.75) < 1e-9), 'held at the seeded position');
	assert.equal(h.proc.voice.lastDir, -1, 'seeded last direction retained during hold');
	assert.equal(h.proc.voice.trapped, true);
	h.call('schedule', {rate: 1}); // resume: dir = (+1) x (-1) = backward
	const t2 = trajectory(h, 50);
	assert.ok(t2[30] < 0.75, 'resumed on the seeded return leg');
});

test('seeds are onset-only: a later plain scrub is not re-seeded', async () => {
	const h = await seeded({active: true, input: 0.7, rate: 1, ...LOOP, loopMode: 'forward', loopTrapped: true});
	trajectory(h, 50);
	assert.equal(h.proc.voice.trapped, true);
	h.call('schedule', {input: 1.3}); // plain explicit scrub beyond the loop
	trajectory(h, 200);
	assert.equal(h.proc.voice.trapped, false, 'scrub reset to untrapped (seed not inherited)');
	assert.ok(h.proc.voice.pos > 1.3, 'continues as a one-shot');
});

test('omission preserves current behaviour; invalid bounds ignore the seed', async () => {
	// no seeds: explicit input beyond the loop stays a one-shot
	let h = await seeded({active: true, input: 1.2, rate: 1, ...LOOP, loopMode: 'forward'});
	trajectory(h, 200);
	assert.equal(h.proc.voice.trapped, false);

	// seed with zero-width bounds: safely ignored
	h = await seeded({active: true, input: 0.7, rate: 1, loopStart: 0.5, loopEnd: 0.5, loopMode: 'forward', loopTrapped: true, loopLeg: -1});
	trajectory(h, 100);
	assert.equal(h.proc.voice.trapped, false, 'invalid loop: seed ignored');
	assert.ok(Number.isFinite(h.proc.voice.pos));
});

test('seeding at the exact loop-end boundary lands on the correct leg', async () => {
	// reverse, seeded turned at exactly loopEnd: descends from the end
	const h = await seeded({active: true, input: 1.0, rate: 1, ...LOOP, loopMode: 'reverse', loopTrapped: true, loopLeg: -1});
	const t = trajectory(h, 50);
	assert.ok(t[10] < 1.0 && t[10] > 0.9, `descending from loop end (${t[10].toFixed(3)})`);
});

test('future-scheduled seeded onset holds its authoritative phase until activation', async () => {
	const h = await createProcessor({sampleRate: SR});
	h.call('addBuffers', sineBuffer({sampleRate: SR, seconds: 2}));
	// Match Aura's handoff topology: the command is delivered with substantial
	// lead, while output/outputTime identify the shared future activation frame.
	h.render(308); // 0.821333s; comfortably before the 1.0s activation
	h.call('schedule', {
		active: true,
		input: 0.7,
		output: 1,
		outputTime: 1,
		rate: 1,
		...LOOP,
		loopMode: 'forward',
		loopTrapped: true,
	});

	let renderedBeforeActivation = 0;
	while (h.renderedSeconds + h.proc.outputLatencySeconds < 1 - 1e-9) {
		h.render(1);
		renderedBeforeActivation++;
		assert.ok(Math.abs(h.proc.voice.pos - 0.7) < 1e-9,
			`phase held before activation (got ${h.proc.voice.pos.toFixed(6)})`);
	}
	assert.ok(renderedBeforeActivation > 10, 'exercised multiple pre-activation render quanta');

	h.render(2);
	assert.ok(h.proc.voice.pos > 0.7, 'phase begins advancing once activation is reached');
});

test('future-onset phase hold covers signed rates and seeded topology return legs', async () => {
	const cases = [
		{name: 'Forward negative Rate', input: 0.8, rate: -1, loopMode: 'forward', after: p => p < 0.8},
		{name: 'Reverse return leg', input: 0.8, rate: 1, loopMode: 'reverse', loopLeg: -1, after: p => p < 0.8},
		{name: 'Reverse return leg, negative Rate', input: 0.7, rate: -1, loopMode: 'reverse', loopLeg: -1, after: p => p > 0.7},
		{name: 'Ping-Pong return leg', input: 0.8, rate: 1, loopMode: 'pingpong', loopLeg: -1, after: p => p < 0.8},
		{name: 'Ping-Pong return leg, negative Rate', input: 0.7, rate: -1, loopMode: 'pingpong', loopLeg: -1, after: p => p > 0.7},
		{name: 'Rate-zero hold', input: 0.75, rate: 0, loopMode: 'pingpong', loopLeg: -1, lastDirection: -1, after: p => Math.abs(p - 0.75) < 1e-9},
	];
	for (const c of cases) {
		const h = await createProcessor({sampleRate: SR});
		h.call('addBuffers', sineBuffer({sampleRate: SR, seconds: 2}));
		h.render(308);
		h.call('schedule', {
			active: true,
			input: c.input,
			output: 1,
			outputTime: 1,
			rate: c.rate,
			...LOOP,
			loopMode: c.loopMode,
			loopTrapped: true,
			loopLeg: c.loopLeg,
			lastDirection: c.lastDirection,
		});
		while (h.renderedSeconds + h.proc.outputLatencySeconds < 1 - 1e-9) {
			h.render(1);
			assert.ok(Math.abs(h.proc.voice.pos - c.input) < 1e-9,
				`${c.name}: phase held before activation`);
		}
		h.render(2);
		assert.ok(c.after(h.proc.voice.pos), `${c.name}: expected post-activation travel/hold (${h.proc.voice.pos})`);
	}
});
