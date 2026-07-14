// Natural-end notification: ['ended', {position, direction, output}] posted
// once when an untrappable voice runs out past its directional end boundary
// (playStart/playEnd, defaulting to the loaded-material edges).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createProcessor, sineBuffer, rms} from './harness.mjs';

const SR = 48000;

function endedEvents(h) {
	return h.posted.filter(m => m[0] === 'ended').map(m => m[1]);
}

async function makeVoice(schedule, seconds = 2) {
	const h = await createProcessor({sampleRate: SR});
	h.call('addBuffers', sineBuffer({sampleRate: SR, seconds}));
	h.call('schedule', schedule);
	return h;
}

test('forward one-shot fires ended once at the end of loaded material', async () => {
	const h = await makeVoice({active: true, input: 1.8, rate: 1, loopMode: 'forward'});
	h.render(200); // 0.53s: crosses the 2.0s end
	const evs = endedEvents(h);
	assert.equal(evs.length, 1, 'exactly one ended event');
	assert.ok(Math.abs(evs[0].position - 2.0) < 0.05, `position ~2.0 (got ${evs[0].position.toFixed(3)})`);
	assert.equal(evs[0].direction, 1);
	h.render(200); // keeps running: no re-fire
	assert.equal(endedEvents(h).length, 1, 'does not re-fire');
});

test('playEnd inside the sample fires early; rendering continues', async () => {
	const h = await makeVoice({active: true, input: 0.5, rate: 1, loopMode: 'forward', playEnd: 1.0});
	const out = h.render(400)[0]; // 1.07s of output
	const evs = endedEvents(h);
	assert.equal(evs.length, 1);
	assert.ok(Math.abs(evs[0].position - 1.0) < 0.05, `position ~playEnd (got ${evs[0].position.toFixed(3)})`);
	// notification only - the engine keeps playing the material past playEnd
	assert.ok(rms(out.subarray(Math.round(0.8*SR))) > 0.05, 'audio continues after the event');
});

test('backward one-shot fires at playStart (mirrored rule)', async () => {
	const h = await makeVoice({active: true, input: 1.5, rate: -1, loopMode: 'forward', playStart: 1.0});
	h.render(400);
	const evs = endedEvents(h);
	assert.equal(evs.length, 1);
	assert.ok(Math.abs(evs[0].position - 1.0) < 0.05, `position ~playStart (got ${evs[0].position.toFixed(3)})`);
	assert.equal(evs[0].direction, -1);
});

test('a voice that can still be trapped never fires; unreachable one-shot does', async () => {
	// trapped voice loops forever: no event even far past playEnd time-wise
	let h = await makeVoice({active: true, input: 0.6, rate: 1, loopStart: 0.5, loopEnd: 1.0, loopMode: 'forward', playEnd: 1.2});
	h.render(800);
	assert.equal(endedEvents(h).length, 0, 'trapped voice never ends');

	// beyond the loop travelling away: unreachable, ends at material edge
	h = await makeVoice({active: true, input: 1.5, rate: 1, loopStart: 0.5, loopEnd: 1.0, loopMode: 'forward'});
	h.render(400);
	assert.equal(endedEvents(h).length, 1, 'unreachable one-shot ends');
});

test('polarity flip toward the material re-arms and cancels the run-out', async () => {
	const h = await makeVoice({active: true, input: 1.9, rate: 1, loopStart: 0.5, loopEnd: 1.0, loopMode: 'forward'});
	h.render(100); // crosses 2.0 -> ended fires
	assert.equal(endedEvents(h).length, 1);
	h.call('schedule', {rate: -1}); // now travelling back toward material and the loop
	h.render(1200); // travels back, enters the loop, gets trapped
	assert.equal(endedEvents(h).length, 1, 'no further events after re-arm');
	assert.equal(h.proc.voice.trapped, true, 'voice re-entered and got trapped');
});

test('scrub back into the material re-arms; second run-out fires again', async () => {
	const h = await makeVoice({active: true, input: 1.8, rate: 1, loopMode: 'forward'});
	h.render(200);
	assert.equal(endedEvents(h).length, 1);
	h.call('schedule', {input: 1.8}); // explicit scrub back inside
	h.render(200); // runs out again
	assert.equal(endedEvents(h).length, 2, 'fires once per run-out');
});

test('rate zero beyond the boundary holds without firing; resume fires', async () => {
	const h = await makeVoice({active: true, input: 1.95, rate: 0, loopMode: 'forward', playEnd: 1.9});
	h.render(100); // held at 1.95, beyond playEnd, but rate 0 = never ends
	assert.equal(endedEvents(h).length, 0, 'held voice does not end');
	h.call('schedule', {rate: 1});
	h.render(50);
	assert.equal(endedEvents(h).length, 1, 'ends on resume');
});

test('invalid playStart/playEnd values are ignored safely', async () => {
	const h = await makeVoice({active: true, input: 1.8, rate: 1, loopMode: 'forward', playEnd: NaN, playStart: Infinity});
	h.render(200); // falls back to material edge at 2.0
	const evs = endedEvents(h);
	assert.equal(evs.length, 1);
	assert.ok(Math.abs(evs[0].position - 2.0) < 0.05, 'fell back to end of loaded audio');
});
