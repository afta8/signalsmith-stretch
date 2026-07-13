// Deterministic Node harness for the AudioWorklet processor in the release
// bundle. Shims the AudioWorkletGlobalScope, drives process() in
// render-quantum steps, and exposes the message protocol.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import url from 'node:url';

const dirname = path.dirname(url.fileURLToPath(import.meta.url));
export const RELEASE_BUNDLE = path.join(dirname, '../release/SignalsmithStretch.js');

export const QUANTUM = 128;

export async function createProcessor({
	bundlePath = RELEASE_BUNDLE,
	sampleRate = 48000,
	channels = 2,
} = {}) {
	const code = fs.readFileSync(bundlePath, 'utf8');
	let registered = null;
	const sandbox = {
		sampleRate,
		currentTime: 0,
		currentFrame: 0,
		AudioWorkletProcessor: class AudioWorkletProcessor {
			constructor() {
				// enforce the real MessagePort rule: a transfer list must not
				// contain duplicate ArrayBuffers (browsers throw DataCloneError)
				this.port = {onmessage: null, postMessage: (data, transfer) => {
					if (transfer && new Set(transfer).size !== transfer.length) {
						throw new Error('DataCloneError: duplicate ArrayBuffer in transfer list');
					}
				}};
			}
		},
		registerProcessor: (name, cls) => { registered = {name, cls}; },
		console, TextDecoder, TextEncoder, Uint8Array, Float32Array, Int32Array,
		WebAssembly, Promise, Math, Date, performance, setTimeout, clearTimeout,
		URL, Blob: globalThis.Blob,
		crypto: globalThis.crypto,
		// Present as a worker-like scope (AudioWorkletGlobalScope is worker-ish)
		WorkerGlobalScope: function WorkerGlobalScope() {},
		location: {href: 'file:///harness/'},
	};
	sandbox.globalThis = sandbox;
	sandbox.self = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox, {filename: path.basename(bundlePath)});
	if (!registered) throw new Error('Processor was not registered');

	const proc = new registered.cls({numberOfOutputs: 1, outputChannelCount: [channels]});

	const posted = []; // every message the processor posts
	const timePosts = []; // {frame, value} for 'time' messages
	let renderedFrames = 0;
	proc.port.postMessage = (data, transfer) => {
		if (transfer && new Set(transfer).size !== transfer.length) {
			throw new Error('DataCloneError: duplicate ArrayBuffer in transfer list');
		}
		posted.push(data);
		if (data[0] === 'time') timePosts.push({frame: renderedFrames, seconds: renderedFrames/sampleRate, value: data[1]});
	};
	let msgId = 0;
	const call = (method, ...args) => {
		proc.port.onmessage({data: [msgId++, method, ...args]});
	};

	await new Promise((resolve, reject) => {
		const t0 = Date.now();
		(function poll() {
			if (proc.wasmReady) return resolve();
			if (Date.now() - t0 > 10000) return reject(new Error('wasm never became ready'));
			setTimeout(poll, 5);
		})();
	});

	return {
		proc, call, posted, timePosts, sandbox, sampleRate, channels,
		get renderedFrames() { return renderedFrames; },
		get renderedSeconds() { return renderedFrames/sampleRate; },
		// Render n quanta; returns Float32Array per channel of everything rendered by this call
		render(nQuanta) {
			const chans = [];
			for (let c = 0; c < channels; ++c) chans.push(new Float32Array(nQuanta*QUANTUM));
			for (let q = 0; q < nQuanta; ++q) {
				sandbox.currentTime = renderedFrames/sampleRate;
				sandbox.currentFrame = renderedFrames;
				const out = [[]];
				for (let c = 0; c < channels; ++c) out[0].push(new Float32Array(QUANTUM));
				proc.process([[]], out, {});
				for (let c = 0; c < channels; ++c) chans[c].set(out[0][c], q*QUANTUM);
				renderedFrames += QUANTUM;
			}
			return chans;
		},
	};
}

// ---- Test signals ----

// Stereo-capable ramp+sine test buffer: returns one Float32Array per channel
export function sineBuffer({sampleRate = 48000, seconds = 2, freq = 220, channels = 2, gain = 0.5}) {
	const n = Math.round(sampleRate*seconds);
	const out = [];
	for (let c = 0; c < channels; ++c) {
		const b = new Float32Array(n);
		for (let i = 0; i < n; i++) b[i] = Math.sin(2*Math.PI*freq*i/sampleRate)*gain;
		out.push(b);
	}
	return out;
}

// Buffer whose instantaneous frequency encodes position: freqA in the first
// half, freqB in the second half. Lets tests hear *where* playback is.
export function splitFreqBuffer({sampleRate = 48000, seconds = 2, freqA = 220, freqB = 880, channels = 2, gain = 0.5}) {
	const n = Math.round(sampleRate*seconds);
	const half = Math.floor(n/2);
	const out = [];
	for (let c = 0; c < channels; ++c) {
		const b = new Float32Array(n);
		let phase = 0;
		for (let i = 0; i < n; i++) {
			const f = i < half ? freqA : freqB;
			phase += 2*Math.PI*f/sampleRate;
			b[i] = Math.sin(phase)*gain;
		}
		out.push(b);
	}
	return out;
}

// Dominant frequency of a chunk via zero-crossing rate (robust enough for
// clean sines well below Nyquist)
export function dominantFreq(chunk, sampleRate) {
	let crossings = 0;
	for (let i = 1; i < chunk.length; i++) {
		if ((chunk[i - 1] < 0) !== (chunk[i] < 0)) crossings++;
	}
	return crossings*sampleRate/(2*chunk.length);
}

export function rms(chunk) {
	let sum = 0;
	for (const s of chunk) sum += s*s;
	return Math.sqrt(sum/chunk.length);
}

export function maxAbs(chunk) {
	let m = 0;
	for (const s of chunk) m = Math.max(m, Math.abs(s));
	return m;
}

export function hasNaN(chunk) {
	for (const s of chunk) if (!Number.isFinite(s)) return true;
	return false;
}
