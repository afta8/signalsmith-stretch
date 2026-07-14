# Signalsmith Stretch Web

This is a fork of the official Signalsmith Stretch release for Web Audio (WASM/AudioWorklet), extended with native loop topologies (`loopMode`: forward/reverse/ping-pong, signed-rate aware, with all loop-boundary decisions made inside the audio thread).  It includes both plain `.js` (UMD), and ES6 `.mjs` versions.

Upstream: https://github.com/Signalsmith-Audio/signalsmith-stretch (MIT).  Consumers that don't set `loopMode` get the original upstream behaviour unchanged.

## How to use it

Call `SignalsmithStretch(audioContext, ?channelOptions)` from the main thread.  This returns a Promise which resolves to an `AudioNode`, with extra methods attached to it.  The optional [`channelOptions` object](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode/AudioWorkletNode#options) can specify the number of inputs/outputs and channels.

It can operate either on live input (if connected to input audio), or on sample buffers you load into it (which can be added/removed dynamically, for streaming).  Either way, you need to call `.start()` (or equivalently `.schedule({active: true})`) for it to start processing audio.

### `stretch.inputTime`

The current input time, within the sample buffer.  You can change how often this is updated, with an optional callback function, using `stretch.setUpdateInterval(seconds, ?callback)`.

### `stretch.schedule({...})`

This adds a scheduled change, removing any scheduled changes occuring after this one.  The object properties are:

* `output` (seconds): audio context time for this change.  The node compensates for its own latency, but this means you might want to schedule some things ahead of time, otherwise you'll have a softer transition as it catches up.
* `active` (bool): processing audio
* `input` (seconds): position in input buffer
* `rate` (number): playback rate, e.g. 0.5 == half speed
* `semitones` (number): pitch shift
* `tonalityHz` (number): tonality limit (default 8000)
* `formantSemitones` (number) / `formantCompensation` (bool): formant shift/compensation
* `formantBaseHz` (number): rough fundamental used for formant analysis (e.g. 100 for low voice, 400 for high voice), or `0` to attempt pitch-tracking
* `loopStart` (seconds) / `loopEnd` (seconds): sets a section of the input buffer to auto-loop.  Disabled if both are set to the same value.
* `loopMode` (`'forward'` | `'reverse'` | `'pingpong'`, optional): loop topology.  When unset, the original (positive-rate forward) looping behaviour is used unchanged.
* `playStart` / `playEnd` (seconds, optional): directional one-shot end boundaries for the natural-end notification (see `stretch.onended`).  They may sit inside the loaded sample and default to the loaded-material edges.  They only affect the notification - rendering is not stopped or silenced.
* `reverseStyle` (`'grain'` | `'mirror'`, optional): rendering character for backward travel (negative-rate playback, scrubs, and the backward legs of `reverse`/`pingpong` loops).  `'grain'` (the default) is the original behaviour: each analysis grain keeps its forward shape while the sequence plays backward.  `'mirror'` is true tape-style reverse: the analysis window is time-reversed, so attacks become swells, the synthesis keeps forward quality, and ping-pong reflections are continuous palindromes.  Setting `reverseStyle` on a segment without `loopMode` opts it into the loop engine (`loopMode: 'forward'`), so one-shots and scrubs can use it.

If the node is processing live input (not a buffer) then `input`/`rate`/`loopStart`/`loopEnd`/`loopMode` are ignored.

### Loop modes

Setting `loopMode` enables a loop engine where every boundary decision happens inside the AudioWorklet, so loop timing never depends on main-thread messages.  `rate` is signed, and the actual travel direction is `rate sign x current loop leg`:

* **`forward`**: positive rates wrap loop end to loop start; negative rates travel backward and wrap loop start to loop end.
* **`reverse`**: playback first travels to the far boundary (loop end at positive rates, loop start at negative), turns there once, then cycles against the rate sign, wrapping at the boundaries.
* **`pingpong`**: playback reflects at each boundary, preserving overshoot.  Positive rates take their first leg toward loop end, negative rates toward loop start.

Behaviour rules shared by all modes:

* The requested `input` position always has priority: playback becomes trapped in the loop only after reaching it from a reachable direction.  A positive-rate start beyond the loop end (or a negative-rate start before the loop start) plays as a one-shot.
* Live `rate` polarity changes reverse the current travel without retriggering or resetting the loop leg.  `rate: 0` keeps the spectral hold, and the last non-zero direction stays defined.
* Moving `loopStart`/`loopEnd` while playback is inside the loop keeps it trapped and phase-maps it into the new window; moving markers before entry doesn't override start reachability.
* Setting invalid or zero-width bounds (`loopEnd <= loopStart`) safely disables looping and releases the voice to ordinary one-shot traversal.
* High rates that cross one or more loop lengths within a render quantum are handled exactly (analytic wrap/reflect), independent of render-quantum size and free of cumulative drift.

### `stretch.onended`

Natural-end callback for loop-engine segments (any segment with `loopMode` set), assigned like `AudioBufferSourceNode.onended`:

```js
stretch.onended = ({position, direction, output}) => { /* release the voice */ };
```

It fires **once per run-out**, from the audio thread's own state, when the voice (a) is not trapped in the loop, (b) cannot currently become trapped (looping disabled, or the loop is unreachable in the travel direction), and (c) has crossed its directional end boundary - `playEnd` when travelling forward, `playStart` when travelling backward (defaults: the edges of the loaded audio).  `output` is the context time at which the crossing becomes audible.

Rendering is *not* stopped - the consumer decides how to end the voice (schedule `{active: false}`, release an envelope, or reuse the node).  The notification re-arms automatically whenever the condition clears: a scrub back into the material, a rate-polarity change back toward it, marker moves that restore reachability, or newly appended buffers extending past the position.  A voice held at `rate: 0` never fires.

### `stretch.start(?when)` / `stretch.stop(?when)`

Starts/stops playback or processing, immediately or at some future time.  These are convenience methods which call `.schedule(...)` under the hood.

`.start()` actually has more parameters, presenting a similar interface to [AudioBufferSourceNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start).

### `stretch.addBuffers([...])`

This adds buffers to the end of the current input sample buffers.  Buffers should be typed arrays of equal length, one per channel.

It can be called multiple times, and the new buffers are inserted immediately after the existing ones, which lets you start playback before the entire audio is loaded.  It returns a Promise for the new sample buffer end time, in seconds.

### `stretch.dropBuffers()`

This drops all input buffers, and resets the input buffer end time to 0.

### `stretch.dropBuffers(toSeconds)`

This drops all input buffers before the given time, but doesn't change the end time.  It returns a Promise for an object with the current input buffer extent: `{start: ..., end: ...}`.

This can be useful when processing streams or very long audio files, letting the Stretch node release old buffers once that section of the input will no longer be played back.

### `stretch.latency()`

Returns the latency when used in "live input" mode, in seconds.  This is also how far ahead you might want to schedule things (`output` in `.schedule()`) to give the node enough time to fully compensate for its own latency.

### `stretch.configure({...})`

Optionally reconfigure, with the following fields:

* `blockMs`: block length in ms (e.g. 120ms)
* `intervalMs`: interval (default `blockMs/4`)
* `splitComputation`: spread computation more evenly across time (default `false`)

If you set `blockMs`  to `0` or `null`, it will check for a `preset` field (with the values `"default"`/`"cheaper"`).
