function registerWorkletProcessor(Module, audioNodeKey) {
	// NOTE: this entire function is stringified into the AudioWorklet module
	// (see the Blob construction below), so all helpers must live inside it.
	const LOOP_MODES = {forward: true, reverse: true, pingpong: true};
	// Backward-travel rendering styles:
	// 'grain' (default) = original behaviour: forward-ordered analysis window,
	//   signed seek rate - each grain keeps its forward shape, sequence reversed
	// 'mirror' = time-reversed analysis window around the mirrored position:
	//   true tape-style reverse (attacks become swells), engine always sees a
	//   forward-moving signal
	const REVERSE_STYLES = {grain: true, mirror: true};
	// Positive modulo (result in [0, m) for m > 0, both signs of x)
	const posMod = (x, m) => ((x%m) + m)%m;
	// Only ordinary ArrayBuffers are transferable.  SharedArrayBuffers stay
	// shared and must never appear in a postMessage transfer list.
	const addTransferableBackingStores = (transfer, sampleBuffers) => {
		sampleBuffers.forEach(buffer => {
			let backingStore = buffer.buffer;
			if (backingStore instanceof ArrayBuffer) transfer.add(backingStore);
		});
	};

	class WasmProcessor extends AudioWorkletProcessor {
		constructor(options) {
			super(options);
			this.wasmReady = false;
			this.wasmModule = null;
			this.channels = 0;
			this.buffersIn = [];
			this.buffersOut = [];
			
			this.audioBuffers = []; // list of (multi-channel) audio buffers
			this.audioBuffersStart = 0; // time-stamp for the first audio buffer
			this.audioBuffersEnd = 0; // just to be helpful
			this._readSeg = 0; // sourceSample() cursor cache
			this._readSegStart = 0;

			// Render-path allocation caches. process() runs on the audio
			// thread, where per-block allocation causes GC glitches, so WASM
			// heap views and the periodic time message are created once and
			// reused; ensureViews() rebuilds only on the rare non-render
			// events (heap growth, buffer reconfiguration).
			this._viewsMemory = null; // ArrayBuffer the cached views were built on
			this._viewsIn = [];
			this._viewsOut = [];
			this._timeMsg = ['time', 0];
			
			this.timeIntervalSamples = sampleRate*0.1;
			this.timeIntervalCounter = 0;
			
			this.timeMap = [{
				active: false,
				input: 0,
				output: 0,
				rate: 1,
				semitones: 0,
				tonalityHz: 8000,
				formantSemitones: 0,
				formantCompensation: false,
				formantBaseHz: 0, /* 0 = attempt to detect */
				loopStart: 0,
				loopEnd: 0,
				loopMode: null, /* null = original behaviour, or 'forward'/'reverse'/'pingpong' */
				loopCrossfade: 0, /* seconds of equal-power seam crossfade (wrapping topologies) */
				reverseStyle: null, /* null = 'grain' (original); or 'mirror' */
				playStart: null, /* one-shot end boundary when travelling backward (null = start of loaded audio) */
				playEnd: null, /* one-shot end boundary when travelling forward (null = end of loaded audio) */
				hasExplicitInput: false
			}];

			// Loop-topology voice state (only used when a segment sets loopMode).
			// All boundary decisions happen here, inside the audio thread.
			this.voice = {
				endedNotified: false, // 'ended' has been posted for the current run-out
				segment: null, // the time-map segment this state was last synced to
				pos: 0, // current input position (seconds)
				anchorOutput: 0, // output time the position was last integrated to
				trapped: false, // has playback entered the loop from a reachable direction?
				rel: 0, // loop-relative position: [0,L) for forward/reverse, phase [0,2L) for pingpong
				turned: false, // reverse mode: initial approach leg has turned at its boundary
				lastDir: 1, // last non-zero actual travel direction (kept while rate == 0)
				loopStart: 0, loopEnd: 0, loopMode: null // loop window the trap state was computed against
			};
			
			let remoteMethods = {
				configure: config => {
					Object.assign(this.config, config);
					this.configure();
				},
				latency: _ => {
					return this.inputLatencySeconds + this.outputLatencySeconds;
				},
				setUpdateInterval: seconds => {
					this.timeIntervalSamples = sampleRate*seconds;
				},
				stop: when => {
					if (typeof when !== 'number') when = currentTime;
					return remoteMethods.schedule({active: false, output: when});
				},
				start: (when, offset, duration, rate, semitones) => {
					if (typeof when === 'object') {
						if (!('active' in when)) when.active = true;
						return remoteMethods.schedule(when);
					}
					
					let obj = {active: true, input: 0, output: currentTime + this.outputLatencySeconds};
					if (typeof when === 'number') obj.output = when;
					if (typeof offset === 'number') obj.input = offset;
					if (typeof rate === 'number') obj.rate = rate;
					if (typeof semitones === 'number') obj.semitones = semitones;
					let result = remoteMethods.schedule(obj);
					if (typeof duration === 'number') {
						remoteMethods.stop(obj.output + duration);
						obj.output += duration;
						obj.active = false;
						remoteMethods.schedule(obj);
					}
					return result;
				},
				schedule: (objIn, adjustPrevious) => {
					let outputTime = ('outputTime' in objIn) ? objIn.outputTime : currentTime;

					let latestSegment = this.timeMap[this.timeMap.length - 1];
					while (this.timeMap.length && this.timeMap[this.timeMap.length - 1].output >= outputTime) {
						latestSegment = this.timeMap.pop();
					}

					let obj = Object.assign({}, latestSegment);
					Object.assign(obj, {
						input: null,
						output: outputTime,
					});
					Object.assign(obj, objIn);
					obj.hasExplicitInput = (objIn.input != null);
					if (obj.loopMode != null && !LOOP_MODES[obj.loopMode]) obj.loopMode = null;
					if (obj.reverseStyle != null && !REVERSE_STYLES[obj.reverseStyle]) obj.reverseStyle = null;
					// reverseStyle needs the loop engine's direction model, even for
					// one-shots (zero-width bounds): opt the segment in
					if (obj.reverseStyle != null && obj.loopMode == null) obj.loopMode = 'forward';
					if (obj.playStart != null && !isFinite(obj.playStart)) obj.playStart = null;
					if (obj.playEnd != null && !isFinite(obj.playEnd)) obj.playEnd = null;
					// crossfade: seconds, inherited like ordinary parameters; invalid -> 0.
					// It does not opt a legacy segment into the loop engine.
					if (typeof obj.loopCrossfade !== 'number' || !isFinite(obj.loopCrossfade) || obj.loopCrossfade < 0) obj.loopCrossfade = 0;
					// Loop-state seeds for onset handoffs. Onset-only contract: they
					// apply only via the call that carries them (with an explicit
					// input) and are never inherited by later segments.
					obj.loopTrapped = ('loopTrapped' in objIn) ? !!objIn.loopTrapped : false;
					obj.loopLeg = (objIn.loopLeg === -1) ? -1 : 1;
					obj.lastDirection = ('lastDirection' in objIn) ? (Math.sign(objIn.lastDirection) || 0) : 0;
					if (obj.input === null) {
						let rate = (latestSegment.active ? latestSegment.rate : 0);
						if (latestSegment.loopMode != null && latestSegment === this.voice.segment) {
							// continue from the topology-mapped voice position, not
							// a loop-unaware linear extrapolation
							obj.input = this.peekVoice(latestSegment, Math.max(0, obj.output - this.voice.anchorOutput)*Math.abs(rate));
						} else {
							obj.input = latestSegment.input + (obj.output - latestSegment.output)*rate;
						}
					}
					this.timeMap.push(obj);

					if (adjustPrevious && this.timeMap.length > 1) {
						let previous = this.timeMap[this.timeMap.length - 2];
						if (previous.output < currentTime) {
							let rate = (previous.active ? previous.rate : 0);
							previous.input += (currentTime - previous.output)*rate;
							previous.output = currentTime;
						}
						previous.rate = (obj.input - previous.input)/(obj.output - previous.output);
					}
	
					let currentMapSegment = this.timeMap[0];
					while (this.timeMap.length > 1 && this.timeMap[1].output <= outputTime) {
						this.timeMap.shift();
						currentMapSegment = this.timeMap[0];
					}
					let rate = (currentMapSegment.active ? currentMapSegment.rate : 0);
					let inputTime;
					if (currentMapSegment.loopMode != null && currentMapSegment === this.voice.segment) {
						inputTime = this.peekVoice(currentMapSegment, Math.max(0, outputTime - this.voice.anchorOutput)*Math.abs(rate));
					} else {
						inputTime = currentMapSegment.input + (outputTime - currentMapSegment.output)*rate;
					}
					this.timeIntervalCounter = this.timeIntervalSamples;
					this.port.postMessage(['time', inputTime]);
					
					return obj;
				},
				dropBuffers: toSeconds => {
					// Transfer lists must contain only unique ordinary ArrayBuffers:
					// channels may share one backing store, and SharedArrayBuffers are
					// shared by structured clone rather than transferred.
					if (typeof toSeconds !== 'number') {
						let transfer = new Set();
						this.audioBuffers.forEach(buffers => addTransferableBackingStores(transfer, buffers));
						this.audioBuffers = [];
						this.audioBuffersStart = this.audioBuffersEnd = 0;
						return {
							value: {start: 0, end: 0},
							transfer: [...transfer]
						};
					}
					let transfer = new Set();
					while (this.audioBuffers.length) {
						let first = this.audioBuffers[0];
						let length = first[0].length;
						let endSamples = this.audioBuffersStart + length;
						let endSeconds = endSamples/sampleRate;
						if (endSeconds > toSeconds) break;

						let dropped = this.audioBuffers.shift();
						addTransferableBackingStores(transfer, dropped);
						this.audioBuffersStart += length;
					}
					transfer = [...transfer];
					return {
						value: {
							start: this.audioBuffersStart/sampleRate,
							end: this.audioBuffersEnd/sampleRate
						},
						transfer: transfer
					};
				},
				addBuffers: sampleBuffers => {
					sampleBuffers = [].concat(sampleBuffers);
					this.audioBuffers.push(sampleBuffers);
					let length = sampleBuffers[0].length;
					this.audioBuffersEnd += length;
					return this.audioBuffersEnd/sampleRate;
				}
			};

			let pendingMessages = [];
			this.port.onmessage = event => pendingMessages.push(event);

			Module().then(wasmModule => {
				this.wasmModule = wasmModule;
				this.wasmReady = true;

				wasmModule._main();

				this.channels = options.numberOfOutputs ? options.outputChannelCount[0] : 2; // stereo by default
				this.configure();

				this.port.onmessage = event => {
					let data = event.data;
					let messageId = data.shift();
					let method = data.shift();
					let result = remoteMethods[method](...data);
					if (result?.transfer) {
						this.port.postMessage([messageId, result.value], result.transfer);
					} else {
						this.port.postMessage([messageId, result]);
					}
				};
				let methodArgCounts = {};
				for (let key in remoteMethods) {
					methodArgCounts[key] = remoteMethods[key].length;
				}
				this.port.postMessage(['ready', methodArgCounts]);
				pendingMessages.forEach(this.port.onmessage);
				pendingMessages = null;
			});
		}
		
		config = {
			preset: 'default'
		};
		configure() {
			if (this.config.blockMs) {
				let blockSamples = Math.round(this.config.blockMs/1000*sampleRate);
				let intervalSamples = Math.round((this.config.intervalMs || this.config.blockMs*0.25)/1000*sampleRate);
				let splitComputation = this.config.splitComputation;
				this.wasmModule._configure(this.channels, blockSamples, intervalSamples, splitComputation);
				this.wasmModule._reset();
			} else if (this.config.preset == 'cheaper') {
				this.wasmModule._presetCheaper(this.channels, sampleRate);
			} else {
				this.wasmModule._presetDefault(this.channels, sampleRate);
			}
			this.updateBuffers();
			this.inputLatencySeconds = this.wasmModule._inputLatency()/sampleRate;
			this.outputLatencySeconds = this.wasmModule._outputLatency()/sampleRate;
		}
		
		updateBuffers() {
			let wasmModule = this.wasmModule;
			// longer than one STFT block, so we can seek smoothly
			this.bufferLength = (wasmModule._inputLatency() + wasmModule._outputLatency());

			let lengthBytes = this.bufferLength*4;
			let bufferPointer = wasmModule._setBuffers(this.channels, this.bufferLength);
			this.buffersIn = [];
			this.buffersOut = [];
			for (let c = 0; c < this.channels; ++c) {
				this.buffersIn.push(bufferPointer + lengthBytes*c);
				this.buffersOut.push(bufferPointer + lengthBytes*(c + this.channels));
			}
			// preallocated scratch for mirrored (time-reversed) window fills
			this.mirrorScratch = [];
			for (let c = 0; c < this.channels; ++c) {
				this.mirrorScratch.push(new Float32Array(this.bufferLength));
			}
			// buffer pointers moved: cached heap views must be rebuilt
			this._viewsMemory = null;
		}

		// Cached per-channel Float32Array views over the WASM heap, spanning
		// the full input/output windows. Rebuilt only when the heap's
		// ArrayBuffer identity changes (WASM memory growth) or after
		// updateBuffers() moves the pointers — never per block, so the
		// steady-state render path performs no allocation.
		ensureViews(memory) {
			if (this._viewsMemory === memory) return;
			this._viewsMemory = memory;
			this._viewsIn.length = 0;
			this._viewsOut.length = 0;
			for (let c = 0; c < this.channels; ++c) {
				this._viewsIn.push(new Float32Array(memory, this.buffersIn[c], this.bufferLength));
				this._viewsOut.push(new Float32Array(memory, this.buffersOut[c], this.bufferLength));
			}
		}

		// Fill the WASM input window (the seek pre-roll) with sample-buffer
		// audio ending at `inputSamplesEnd`, zero-padded outside the stored audio
		fillInputWindow(memory, inputSamplesEnd) {
			this.ensureViews(memory);
			this.fillForward(this._viewsIn, inputSamplesEnd);
		}

		// Mirrored fill: the window contains the source time-reversed, newest
		// sample = `newestSample`, so the engine sees a forward-moving signal
		// while the voice travels backward
		fillInputWindowMirrored(memory, newestSample) {
			this.fillForward(this.mirrorScratch, newestSample + this.bufferLength);
			this.ensureViews(memory);
			let n = this.bufferLength;
			for (let c = 0; c < this.channels; ++c) {
				let view = this._viewsIn[c];
				let src = this.mirrorScratch[c%this.mirrorScratch.length];
				for (let j = 0; j < n; j++) view[j] = src[n - 1 - j];
			}
		}

		// Random-access source read (absolute sample index), zero outside the
		// stored audio. Cursor-cached across calls for near-monotonic access;
		// exact for any segmented addBuffers() layout.
		sourceSample(c, i) {
			if (i < this.audioBuffersStart || i >= this.audioBuffersEnd) return 0;
			let bufs = this.audioBuffers;
			let k = this._readSeg, start = this._readSegStart;
			if (k >= bufs.length) { k = 0; start = this.audioBuffersStart; }
			while (i < start) { --k; start -= bufs[k][0].length; }
			while (i >= start + bufs[k][0].length) { start += bufs[k][0].length; ++k; }
			this._readSeg = k;
			this._readSegStart = start;
			let chans = bufs[k];
			return chans[c%chans.length][i - start];
		}

		// Duration-preserving in-loop seam taper for crossfaded wrapping loops.
		// The analysis window is synthesised along the travel path over the FULL
		// loop length L (phase clock unchanged - crossfade never alters duration
		// or the reported playhead). Within F on BOTH sides of the wrap, the
		// primary read is equal-power-blended with a same-direction continuation:
		// the approach crosses into the far-side material, then the recovery side
		// returns to the authoritative phase. This keeps every read in-loop and
		// never reflects/reverses source material. One voice, one process() call.
		fillInputWindowSeamTaper(memory, seg, dir, style, Lsec, Fsec) {
			this.ensureViews(memory);
			let n = this.bufferLength;
			let S = seg.loopStart*sampleRate;
			let L = Lsec*sampleRate;
			let F = Fsec*sampleRate;
			let loEnd = Math.round(S + L) - 1; // last strictly-in-loop sample index
			let relS = this.voice.rel*sampleRate;
			let anchor = n - Math.round(this.inputLatencySeconds*sampleRate);
			// grain keeps its source-ordered window for backward travel
			// (ascending index = descending travel offset); mirror and forward
			// travel are travel-ordered
			let backwardGrain = (dir < 0 && style !== 'mirror');
			let halfPi = Math.PI*0.5;
			let loStart = Math.round(S);
			for (let c = 0; c < this.channels; ++c) {
				let view = this._viewsIn[c];
				this._readSeg = 0;
				this._readSegStart = this.audioBuffersStart;
				for (let j = 0; j < n; ++j) {
					let delta = backwardGrain ? (anchor - j) : (j - anchor);
					let cp = posMod(relS + dir*delta, L); // full-L phase position
					let primaryIndex = Math.round(S + cp);
					if (primaryIndex < loStart) primaryIndex = loStart;
					else if (primaryIndex > loEnd) primaryIndex = loEnd;
					let primary = this.sourceSample(c, primaryIndex);
					let secondaryPhase = -1;
					let primaryGain = 1;
					let secondaryGain = 0;
					if (dir > 0 && cp >= L - F) {
						// Forward approach: tail -> head, both read forward.
						let x = (cp - (L - F))/F;
						secondaryPhase = cp - (L - F);
						primaryGain = Math.cos(x*halfPi);
						secondaryGain = Math.sin(x*halfPi);
					} else if (dir > 0 && cp < F) {
						// Forward recovery: continued head -> authoritative head.
						let x = cp/F;
						secondaryPhase = F + cp;
						primaryGain = Math.sin(x*halfPi);
						secondaryGain = Math.cos(x*halfPi);
					} else if (dir < 0 && cp < F) {
						// Backward approach: head -> tail, both read backward.
						let x = (F - cp)/F;
						secondaryPhase = L - F + cp;
						primaryGain = Math.cos(x*halfPi);
						secondaryGain = Math.sin(x*halfPi);
					} else if (dir < 0 && cp >= L - F) {
						// Backward recovery: continued tail -> authoritative tail.
						let x = (L - cp)/F;
						secondaryPhase = cp - F;
						primaryGain = Math.sin(x*halfPi);
						secondaryGain = Math.cos(x*halfPi);
					}
					if (secondaryPhase >= 0) {
						let secondaryIndex = Math.round(S + secondaryPhase);
						if (secondaryIndex < loStart) secondaryIndex = loStart;
						else if (secondaryIndex > loEnd) secondaryIndex = loEnd;
						let secondary = this.sourceSample(c, secondaryIndex);
						view[j] = primaryGain*primary + secondaryGain*secondary;
					} else view[j] = primary;
				}
			}
		}

		// Copy sample-buffer audio ending at `inputSamplesEnd` (exclusive) into
		// the target arrays, zero-padded outside the stored audio
		fillForward(buffers, inputSamplesEnd) {
			let numBuffers = buffers.length;
			let blockSamples = 0; // current write position in the temporary input buffer
			let audioBufferIndex = 0;
			let audioSamples = this.audioBuffersStart; // start of current audio buffer
			// zero-pad until the start of the audio data
			let inputSamples = inputSamplesEnd - this.bufferLength;
			if (inputSamples < audioSamples) {
				blockSamples = audioSamples - inputSamples;
				for (let c = 0; c < numBuffers; ++c) buffers[c].fill(0, 0, blockSamples);
				inputSamples = audioSamples;
			}
			while (audioBufferIndex < this.audioBuffers.length && audioSamples < inputSamplesEnd) {
				let audioBuffer = this.audioBuffers[audioBufferIndex];
				let startIndex = inputSamples - audioSamples; // start index within the audio buffer
				let bufferEnd = audioSamples + audioBuffer[0].length;
				// how many samples to copy: min(how many left in the buffer, how many more we need)
				let count = Math.min(audioBuffer[0].length - startIndex, inputSamplesEnd - inputSamples);
				if (count > 0) {
					// indexed copy: subarray() would allocate a view per
					// channel per block on the audio thread
					for (let c = 0; c < numBuffers; ++c) {
						let buffer = buffers[c];
						let channelBuffer = audioBuffer[c%audioBuffer.length];
						for (let j = 0; j < count; ++j) {
							buffer[blockSamples + j] = channelBuffer[startIndex + j];
						}
					}
					audioSamples += count;
					blockSamples += count;
				} else { // we're already past this buffer - skip it
					audioSamples += audioBuffer[0].length;
				}
				++audioBufferIndex;
			}
			if (blockSamples < this.bufferLength) {
				for (let c = 0; c < numBuffers; ++c) buffers[c].fill(0, blockSamples);
			}
		}

		// ---- Loop-topology engine (active when a segment sets loopMode) ----
		// All loop-boundary decisions and direction changes happen here, on the
		// audio thread, using analytic wrap/reflect arithmetic: exact for
		// arbitrarily high rates and multiple boundary crossings per block,
		// independent of the render-quantum size, with no cumulative drift.

		loopLength(seg) {
			let L = seg.loopEnd - seg.loopStart;
			return (isFinite(L) && L > 0) ? L : 0; // invalid/zero-width bounds disable looping
		}

		// Effective seam crossfade in seconds: clamped to half the loop width
		effectiveCrossfade(seg) {
			let cf = seg.loopCrossfade;
			if (!(cf > 0)) return 0;
			let L = this.loopLength(seg);
			if (!L) return 0;
			return Math.min(cf, L*0.5);
		}

		// Sync voice state when the current time-map segment changes: explicit
		// scrubs re-evaluate reachability, continuations keep the integrated
		// position, live marker moves phase-map into the new window.
		syncVoice(seg, outputTime) {
			let v = this.voice;
			if (v.segment === seg) return;
			if (seg.hasExplicitInput || v.segment === null) {
				// A requested input/start position always has priority: the trap
				// state is re-evaluated from here by the reachability rules.
				v.pos = seg.input;
				v.anchorOutput = seg.output;
				v.trapped = false;
				v.turned = false;
				v.rel = 0;
				v.endedNotified = false;
				if (seg.lastDirection) v.lastDir = seg.lastDirection;
				if (seg.loopTrapped) {
					// Onset handoff: seed existing loop-topology state instead of
					// re-evaluating reachability. loopLeg 1 = the rate-sign leg,
					// -1 = the return leg (actual direction = rate sign x leg).
					let L = this.loopLength(seg);
					if (L) {
						let a = seg.input - seg.loopStart;
						if (a < 0 || a > L) a = posMod(a, L); // phase-map, keeping the closed top edge
						v.trapped = true;
						if (seg.loopMode === 'pingpong') {
							v.rel = (seg.loopLeg === -1) ? posMod(2*L - a, 2*L) : a;
						} else {
							v.rel = a;
							v.turned = (seg.loopMode === 'reverse' && seg.loopLeg === -1);
						}
						v.pos = seg.loopStart + a;
					}
				}
			} else {
				// Continuation segment (rate/pitch/marker/mode changes): keep the
				// integrated position; main-thread extrapolation is not trusted
				// across loop seams.
				let L = this.loopLength(seg);
				if (!L) {
					v.trapped = false; // release back to one-shot traversal
				} else if (v.trapped) {
					let modeChanged = seg.loopMode !== v.loopMode;
					let windowMoved = seg.loopStart !== v.loopStart || seg.loopEnd !== v.loopEnd;
					if (modeChanged) {
						// deterministic re-entry into the new topology at the current position
						v.rel = posMod(v.pos - seg.loopStart, L);
						v.turned = false;
					} else if (windowMoved) {
						// stay trapped: phase-map into the new window, preserving the current leg
						let a = posMod(v.pos - seg.loopStart, L);
						if (seg.loopMode === 'pingpong') {
							let oldL = v.loopEnd - v.loopStart;
							let leg = (v.rel < oldL) ? 1 : -1;
							v.rel = (leg > 0) ? a : posMod(2*L - a, 2*L);
							v.pos = seg.loopStart + ((v.rel < L) ? v.rel : 2*L - v.rel);
						} else {
							v.rel = a;
							v.pos = seg.loopStart + a;
						}
					}
				}
			}
			v.loopStart = seg.loopStart;
			v.loopEnd = seg.loopEnd;
			v.loopMode = seg.loopMode;
			v.segment = seg;
		}

		// Advance the voice to `outputTime`. Travel is rate-signed input-domain
		// distance; the mode formulas map it to actual motion.
		advanceVoice(seg, outputTime) {
			let v = this.voice;
			let elapsed = outputTime - v.anchorOutput;
			// A future-scheduled onset can become the selected segment during seek
			// pre-roll. Until its activation time, keep both phase and anchor at the
			// future frame; moving the anchor backward would make later pre-roll
			// quanta advance the voice early and create a stable handoff offset.
			if (!(elapsed > 0)) return;
			let travel = elapsed*seg.rate;
			v.anchorOutput = outputTime;
			let L = this.loopLength(seg);
			if (!L) {
				v.trapped = false;
				v.pos += travel;
				return;
			}
			if (v.trapped) {
				this.travelTrapped(seg, travel, L);
				return;
			}
			let dir = Math.sign(seg.rate) || v.lastDir;
			let p0 = v.pos, p1 = p0 + travel;
			let inside = (dir > 0)
				? (p0 >= seg.loopStart && p0 < seg.loopEnd)
				: (p0 > seg.loopStart && p0 <= seg.loopEnd);
			if (inside) {
				this.trapVoice(p0 - seg.loopStart);
				this.travelTrapped(seg, travel, L);
			} else if (travel > 0 && p0 < seg.loopStart && p1 >= seg.loopStart) {
				this.trapVoice(0);
				this.travelTrapped(seg, p1 - seg.loopStart, L);
			} else if (travel < 0 && p0 > seg.loopEnd && p1 <= seg.loopEnd) {
				this.trapVoice(L);
				this.travelTrapped(seg, p1 - seg.loopEnd, L);
			} else {
				// not reachable (yet): the start position has priority, so e.g.
				// positive playback starting beyond loop end stays a one-shot
				v.pos = p1;
			}
		}

		trapVoice(rel) {
			let v = this.voice;
			v.trapped = true;
			v.turned = false;
			v.rel = rel;
		}

		travelTrapped(seg, travel, L) {
			let v = this.voice;
			// The topology clock always advances/wraps over the full loop length L,
			// independent of loopCrossfade: the crossfade is a seam-rendering effect
			// only (see fillInputWindowSeamTaper) and must never change duration,
			// phase, wrap cadence, or reported inputTime.
			if (seg.loopMode === 'forward') {
				// wraps end-to-start at positive rates, start-to-end at negative
				v.rel = posMod(v.rel + travel, L);
				v.pos = seg.loopStart + v.rel;
			} else if (seg.loopMode === 'pingpong') {
				// phase in [0,2L): first half is the rate-sign leg, second half
				// the reflected leg; overshoot is preserved by the phase wrap
				v.rel = posMod(v.rel + travel, 2*L);
				v.pos = seg.loopStart + ((v.rel < L) ? v.rel : 2*L - v.rel);
			} else { // reverse
				if (!v.turned) {
					// initial approach leg: travels linearly to its boundary, turns there
					let relLin = v.rel + travel;
					if (relLin >= 0 && relLin < L) {
						v.rel = relLin;
					} else if (relLin >= L) { // turn at loop end, preserving overshoot
						v.turned = true;
						let r = 2*L - relLin;
						v.rel = (r >= 0) ? r : posMod(r, L);
					} else { // turn at loop start, preserving overshoot
						v.turned = true;
						let r = -relLin;
						v.rel = (r <= L) ? r : posMod(r, L);
					}
				} else {
					// after the turn the loop cycles against the rate sign,
					// wrapping (not reflecting) at the boundaries over the full L
					// (the initial turnaround above is a reflection, never a
					// crossfaded seam)
					v.rel = posMod(v.rel - travel, L);
				}
				v.pos = seg.loopStart + v.rel;
			}
		}

		// actual direction = rate sign x current loop leg
		voiceDirection(seg) {
			let v = this.voice;
			let rateSign = Math.sign(seg.rate);
			if (!rateSign) return 0;
			if (!v.trapped || seg.loopMode === 'forward') return rateSign;
			if (seg.loopMode === 'pingpong') {
				return (v.rel < seg.loopEnd - seg.loopStart) ? rateSign : -rateSign;
			}
			return v.turned ? -rateSign : rateSign; // reverse
		}

		// Natural-end notification: posts ['ended', {position, direction, output}]
		// once when the voice has run out past its directional end boundary and
		// cannot (currently) be trapped by the loop. The play region (playStart/
		// playEnd) may sit inside the loaded sample; it bounds one-shot travel
		// only - trapped voices loop regardless. Re-arms automatically whenever
		// the condition clears (scrub back in, polarity flip toward material,
		// marker moves that restore reachability, newly streamed buffers).
		// Rendering is not stopped: the consumer decides how to end the voice.
		checkEnded(seg, dir, outputTime) {
			let v = this.voice;
			if (!dir) return; // rate 0 holds - a held voice never runs out
			let L = this.loopLength(seg);
			let canTrap = false;
			if (L) {
				canTrap = v.trapped || (dir > 0 ? v.pos < seg.loopEnd : v.pos > seg.loopStart);
			}
			let ended = false;
			if (!canTrap) {
				if (dir > 0) {
					let end = (seg.playEnd != null) ? seg.playEnd : this.audioBuffersEnd/sampleRate;
					ended = v.pos >= end;
				} else {
					let start = (seg.playStart != null) ? seg.playStart : this.audioBuffersStart/sampleRate;
					ended = v.pos <= start;
				}
			}
			if (ended && !v.endedNotified) {
				v.endedNotified = true;
				// `output` is the context time at which the crossing is audible
				this.port.postMessage(['ended', {position: v.pos, direction: dir, output: outputTime}]);
			} else if (!ended) {
				v.endedNotified = false;
			}
		}

		// Where playback will be `lookahead` input-seconds further along its
		// travel, mapped through the loop topology. Pure - no state changes.
		peekVoice(seg, lookahead) {
			let v = this.voice;
			let L = this.loopLength(seg);
			let rateSign = Math.sign(seg.rate) || v.lastDir;
			let travel = rateSign*lookahead;
			if (!v.trapped || !L) return v.pos + travel;
			// full-L clock (crossfade never affects reported position; see travelTrapped)
			if (seg.loopMode === 'forward') {
				return seg.loopStart + posMod(v.rel + travel, L);
			} else if (seg.loopMode === 'pingpong') {
				let phi = posMod(v.rel + travel, 2*L);
				return seg.loopStart + ((phi < L) ? phi : 2*L - phi);
			} else if (!v.turned) { // reverse, still approaching: reflect once
				let relLin = v.rel + travel;
				if (relLin >= L) relLin = 2*L - relLin;
				else if (relLin < 0) relLin = -relLin;
				if (relLin < 0 || relLin > L) relLin = posMod(relLin, L);
				return seg.loopStart + relLin;
			}
			// reverse, cycling
			return seg.loopStart + posMod(v.rel - travel, L);
		}

		process(inputList, outputList, parameters) {
			if (!this.wasmReady) {
				outputList.forEach(output => {
					output.forEach(channel => {
						channel.fill(0);
					});
				});
				return true;
			}
			if (!outputList[0]?.length) return false;

			let outputTime = currentTime + this.outputLatencySeconds;
			while (this.timeMap.length > 1 && this.timeMap[1].output <= outputTime) {
				this.timeMap.shift();
			}
			let currentMapSegment = this.timeMap[0];

			let wasmModule = this.wasmModule;
			wasmModule._setTransposeSemitones(currentMapSegment.semitones, currentMapSegment.tonalityHz/sampleRate);
			wasmModule._setFormantSemitones(currentMapSegment.formantSemitones, currentMapSegment.formantCompensation);
			wasmModule._setFormantBase(currentMapSegment.formantBaseHz/sampleRate);

			// Check the input/output channel counts
			if (outputList[0].length != this.channels) {
				this.channels = outputList[0]?.length || 0;
				this.configure();
			}
			let outputBlockSize = outputList[0][0].length;

			let memory = wasmModule.exports ? wasmModule.exports.memory.buffer : wasmModule.HEAP8.buffer;
			this.ensureViews(memory);
			// Buffer list (one per channel)
			let inputs = inputList[0];
			if (!currentMapSegment.active) {
				for (let c = 0; c < this.channels; ++c) {
					this._viewsIn[c].fill(0, 0, outputBlockSize);
				}
				// Should detect silent input and skip processing
				wasmModule._process(outputBlockSize, outputBlockSize);
			} else if (inputs?.length) {
				// Live input
				for (let c = 0; c < this.channels; ++c) {
					let channelBuffer = inputs[c%inputs.length];
					let view = this._viewsIn[c];
					if (channelBuffer) {
						view.set(channelBuffer);
					} else {
						view.fill(0, 0, outputBlockSize);
					}
				}
				wasmModule._process(outputBlockSize, outputBlockSize);
			} else {
				let seg = currentMapSegment;
				let reportTime;
				if (seg.loopMode == null) {
					// Original behaviour, kept exactly for consumers that don't
					// specify a loop mode
					let inputTime = seg.input + (outputTime - seg.output)*seg.rate;
					let loopLength = seg.loopEnd - seg.loopStart;
					if (loopLength > 0 && inputTime >= seg.loopEnd) {
						seg.input -= loopLength;
						inputTime -= loopLength;
					}

					inputTime += this.inputLatencySeconds;
					// keep the voice position fresh, so a later loop-mode segment
					// can continue from here
					this.voice.pos = inputTime - this.inputLatencySeconds;
					this.voice.anchorOutput = outputTime;
					this.voice.trapped = false;
					this.voice.segment = seg;

					this.fillInputWindow(memory, Math.round(inputTime*sampleRate));
					// constantly seeking, so we don't have to worry about the input buffers needing to be a rate-dependent size
					wasmModule._seek(this.bufferLength, seg.rate);
					reportTime = inputTime;
				} else {
					this.syncVoice(seg, outputTime);
					let v = this.voice;
					this.advanceVoice(seg, outputTime);
					let dir = this.voiceDirection(seg);
					this.checkEnded(seg, dir, outputTime);
					if (dir) v.lastDir = dir;
					else dir = v.lastDir; // rate zero: hold the last orientation

					let style = seg.reverseStyle || 'grain';
					let Fsec = this.effectiveCrossfade(seg);
					let Lsec = this.loopLength(seg);
					// seam-tapered fill: wrapping topologies only (never ping-pong,
					// never reverse's pre-turn approach), and only once trapped.
					// The topology clock is unchanged; this only softens the seam.
					let tapered = Fsec > 0 && v.trapped
						&& (seg.loopMode === 'forward' || (seg.loopMode === 'reverse' && v.turned));
					if (tapered) {
						this.fillInputWindowSeamTaper(memory, seg, dir, style, Lsec, Fsec);
						wasmModule._seek(this.bufferLength, (style === 'mirror' && dir < 0) ? Math.abs(seg.rate) : dir*Math.abs(seg.rate));
					} else if (style === 'mirror' && dir < 0) {
						// time-reversed window with the lookahead facing the travel
						// direction; engine runs forward at |rate|
						this.fillInputWindowMirrored(memory, Math.round((v.pos - this.inputLatencySeconds)*sampleRate));
						wasmModule._seek(this.bufferLength, Math.abs(seg.rate));
					} else {
						this.fillInputWindow(memory, Math.round((v.pos + this.inputLatencySeconds)*sampleRate));
						// 'grain': seek direction follows the actual travel (rate sign x loop leg)
						wasmModule._seek(this.bufferLength, dir*Math.abs(seg.rate));
					}
					// reported time matches the audible loop position and direction
					reportTime = this.peekVoice(seg, this.inputLatencySeconds);
				}
				wasmModule._process(0, outputBlockSize);

				this.timeIntervalCounter -= outputBlockSize;
				if (this.timeIntervalCounter <= 0) {
					this.timeIntervalCounter = this.timeIntervalSamples;
					// postMessage clones synchronously, so the preallocated
					// message array is safe to reuse every interval
					this._timeMsg[1] = reportTime;
					this.port.postMessage(this._timeMsg);
				}
			}

			// Re-fetch in case the memory changed (even though there *shouldn't* be any allocations)
			memory = wasmModule.exports ? wasmModule.exports.memory.buffer : wasmModule.HEAP8.buffer;
			this.ensureViews(memory);
			for (let c = 0; c < this.channels; ++c) {
				let channelBuffer = outputList[0][c];
				let view = this._viewsOut[c];
				for (let j = 0; j < outputBlockSize; ++j) {
					channelBuffer[j] = view[j];
				}
			}

			return true;
		}
	}

	registerProcessor(audioNodeKey, WasmProcessor);
}

/**
	Creates a Stretch node
	@async
	@function SignalsmithStretch
	@param {AudioContext} audioContext
	@param {Object} options - channel configuration (as per [options]{@link https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode/AudioWorkletNode#options})
	@returns {Promise<StretchNode>}
*/
SignalsmithStretch = ((Module, audioNodeKey) => {
	if (typeof AudioWorkletProcessor === "function" && typeof registerProcessor === "function") {
		// AudioWorklet side
		registerWorkletProcessor(Module, audioNodeKey);
		return {};
	}
	let promiseKey = Symbol();
	let createNode = async function(audioContext, options) {
		/**
			@classdesc An `AudioWorkletNode` with Signalsmith Stretch extensions
			@name StretchNode
			@augments AudioWorkletNode
			@property {number} inputTime - the current playback (in seconds) within the input audio stored by the node
		 */
		let audioNode;
		options = options || {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [2]
		};
		try {
			audioNode = new AudioWorkletNode(audioContext, audioNodeKey, options);
		} catch (e) {
			if (!audioContext[promiseKey]) {
				let moduleUrl = createNode.moduleUrl;
				if (!moduleUrl) {
					let moduleCode = `(${registerWorkletProcessor})((_scriptName=>${Module})(),${JSON.stringify(audioNodeKey)})`;
					moduleUrl = URL.createObjectURL(new Blob([moduleCode], {type: 'text/javascript'}));
				}
				audioContext[promiseKey] = audioContext.audioWorklet.addModule(moduleUrl);
			}
			await audioContext[promiseKey];
			audioNode = new AudioWorkletNode(audioContext, audioNodeKey, options);
		}

		// messages with Promise responses
		let requestMap = {};
		let idCounter = 0;
		let timeUpdateCallback = null;
		let post = (transfer, ...data) => {
			let id = idCounter++;
			return new Promise(resolve => {
				requestMap[id] = resolve;
				audioNode.port.postMessage([id].concat(data), transfer);
			});
		};
		audioNode.inputTime = 0;
		audioNode.onended = null; // natural-end callback: ({position, direction, output}) => {}
		audioNode.port.onmessage = (event) => {
			let data = event.data;
			let id = data[0], value = data[1];
			if (id == 'time') {
				audioNode.inputTime = value;
				if (timeUpdateCallback) timeUpdateCallback(value);
			}
			if (id == 'ended' && audioNode.onended) {
				audioNode.onended(value);
			}
			if (id in requestMap) {
				requestMap[id](value);
				delete requestMap[id];
			}
		};
		
		return new Promise(resolve => {
			requestMap['ready'] = remoteMethodKeys => {
				Object.keys(remoteMethodKeys).forEach(key => {
					let argCount = remoteMethodKeys[key];
					audioNode[key] = (...args) => {
						let transfer = null;
						if (args.length > argCount) {
							transfer = args.pop();
						}
						return post(transfer, key, ...args);
					}
				});
				/** @lends StretchNode.prototype
					@method setUpdateInterval
				*/
				audioNode.setUpdateInterval = (seconds, callback) => {
					timeUpdateCallback = callback;
					return post(null, 'setUpdateInterval', seconds);
				}
				resolve(audioNode);
			}
		});
	};
	return createNode;
})(SignalsmithStretch, "signalsmith-stretch");
// register as a CommonJS/AMD module
if (typeof exports === 'object' && typeof module === 'object') {
	module.exports = SignalsmithStretch;
} else if (typeof define === 'function' && define['amd']) {
	define([], () => SignalsmithStretch);
}
