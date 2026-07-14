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
* `loopTrapped` (bool) / `loopLeg` (`1` | `-1`) / `lastDirection` (`1` | `-1`) (optional, **onset-only**): loop-state seeds for engine handoffs — see "Seeding loop state" below.
* `reverseStyle` (`'grain'` | `'mirror'`, optional): rendering character for backward travel (negative-rate playback, scrubs, and the backward legs of `reverse`/`pingpong` loops).  `'grain'` (the default) is the original behaviour: each analysis grain keeps its forward shape while the sequence plays backward.  `'mirror'` is true tape-style reverse: the analysis window is time-reversed, so attacks become swells, the synthesis keeps forward quality, and ping-pong reflections are continuous palindromes.  Setting `reverseStyle` on a segment without `loopMode` opts it into the loop engine (`loopMode: 'forward'`), so one-shots and scrubs can use it.
* `loopCrossfade` (seconds, optional, default `0`): equal-power crossfade across the discontinuous loop seam — see "Loop crossfade" below.

If the node is processing live input (not a buffer) then `input`/`rate`/`loopStart`/`loopEnd`/`loopMode`/`loopCrossfade` are ignored.

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

### Loop crossfade

`loopCrossfade` (seconds) blends the otherwise-discontinuous loop seam with an equal-power crossfade, in the style of a sampler loop crossfade.  It applies only when a native `loopMode` is active (it does not opt a legacy segment into the loop engine), and only to the **wrapping** seam of a topology:

* **Forward**: every wrap (loop end → loop start at positive rate, loop start → loop end at negative rate).
* **Reverse**: only the wrapping seam *after* the initial turnaround.  The initial turn is a reflection, not a discontinuous wrap, and is never crossfaded.
* **Ping-pong**: no effect (it reflects, so there is no discontinuous wrap).  The requested value is retained and becomes active again if you switch to Forward or Reverse.

**Duration-preserving invariant.**  Loop crossfade softens a wrapping seam **without changing the loop's source duration or phase cadence**.  The loop period is exactly `loopLength / abs(rate)` regardless of `loopCrossfade`; the crossfade affects rendered audio only.  It never changes `inputTime`, the reported playhead, the wrap cadence, the topology leg/direction, trap/turn positions, or scheduling — a voice with `loopCrossfade > 0` follows exactly the same position trajectory as the same voice at `loopCrossfade = 0`.

Rules:

* Unit is source/input seconds, consistent with `loopStart`/`loopEnd`.  Negative, non-finite or non-numeric values normalise to `0`.
* The effective crossfade is clamped to half the loop width: `min(loopCrossfade, (loopEnd - loopStart) / 2)`.
* It is inherited by continuation segments like ordinary parameters, and can be changed live — including across a seam — without retriggering, resetting pitch, changing the tempo, or releasing the loop trap.
* All seam reads stay strictly **inside** `[loopStart, loopEnd)`; no material from outside the loop is used.

`reverseStyle` (`'grain'`/`'mirror'`) is fully compatible: the seam timing, duration and reported playhead are identical across styles; only the established backward-rendering character differs.

The implementation uses a **single** Signalsmith voice and one `process()` call per block — the seam is smoothed by synthesising the near-seam region of the analysis input in the worklet; there is no second voice.

**Seam-quality note.**  Because a duration-preserving loop reads only in-loop audio, the seam discontinuity cannot be made perfectly transparent the way a cycle-shortening crossfade can (that would change the tempo).  The taper makes the seam substantially smoother than no crossfade — and never clickier — but a small residual can remain; on strongly correlated tonal material the equal-power blend can also introduce mild phasing or a brief level change in the fade region.  The phase-vocoder overlap-add tends to mask what remains.  Preserving duration and phase takes priority over fully erasing the seam.

### Seeding loop state (onset handoffs)

When initialising a new explicit-input onset that should *continue* existing loop
topology (e.g. handing a looping voice over from another playback engine), the same
`schedule()` call that carries `input` can seed the voice state:

* `loopTrapped` (bool): start already trapped in the loop instead of re-evaluating
  start-position reachability.  If the provided `input` lies outside the loop window it
  is phase-mapped in.  Ignored when the loop bounds are invalid/zero-width.
* `loopLeg` (`1` | `-1`, default `1`): the current loop leg — `1` is the rate-sign
  ("first"/Forward) leg, `-1` the return leg, following the direction model
  `actual direction = rate sign x leg`.  For `reverse` mode, `-1` means the initial
  turn has already happened; for `forward` mode the leg is ignored.
* `lastDirection` (`1` | `-1`): seeds the last non-zero actual direction, so a
  handoff at `rate: 0` holds with the correct orientation and resumes correctly.

These work for all three loop modes, both rate signs, and rate zero.  They are
**onset-only**: consumed by the call that carries them (alongside an explicit `input`)
and never inherited by later segments — a later plain scrub resets to untrapped and
re-evaluates reachability as normal.  Omitting them preserves the existing
explicit-input behaviour exactly.

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
