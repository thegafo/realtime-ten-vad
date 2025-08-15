# RealtimeTenVad (TEN VAD – Realtime, Node.js)

Tiny realtime VAD wrapper around a WASM backend. Feed it 16 kHz mono float audio (`Float32Array` in `[-1,1]`), and get start/end callbacks for detected speech.

Adapted from [TEN-VAD](https://github.com/TEN-framework/ten-vad/blob/main/examples/test_node.js).

## Installation and Usage

```sh
npm install realtime-ten-vad
```

Require and use as follows:

```js
// Use main export (index.js):
const { RealtimeTenVad } = require('realtime-ten-vad');

const vad = await RealtimeTenVad.new({
  // Callbacks
  onSpeechStart() { /* speech just began */ },
  onSpeechEnd(seg) { /* seg: Float32Array @ 16 kHz with pre/post padding */ },
  onVADMisfire() { /* segment shorter than minSpeechMs */ },

  // Tunables (all optional; shown with defaults)
  positiveSpeechThreshold: 0.6,
  negativeSpeechThreshold: 0.4,
  minSpeechFrames: 3,
  minSilenceFrames: 8,
  probSmoothing: 0.2,
  energyGateDb: null,
  preEmphasis: 0.0,
  preSpeechPadMs: 80,
  postSpeechPadMs: 160,
  minSpeechMs: 150,
});

// stream audio
vad.processAudio(float32Chunk);
// when you're done:
vad.flush();
vad.destroy();
```

## Options (what they do)

### Callbacks

* `onSpeechStart(): void`
  Fired once when the VAD transitions into speech (after the minimum entry condition is met). No arguments.
* `onSpeechEnd(seg: Float32Array): void`
  Fired when a speech segment is finalized (after trailing silence + post-pad). `seg` is 16 kHz mono, includes configured pre/post padding.
* `onVADMisfire(): void`
  Fired instead of `onSpeechEnd` if the detected segment’s duration is `< minSpeechMs`.

### Tunables / knobs

| Option                    |         Type (range) | Default | Meaning & tips                                                                                                       |
|-------------------------- | -------------------:| -------:| -------------------------------------------------------------------------------------------------------------------- |
| `positiveSpeechThreshold` |      `number` (0..1) |   `0.6` | Probability threshold to **enter** speech when in silence. Higher = stricter start                                  |
| `negativeSpeechThreshold` |      `number` (0..1) |   `0.4` | Probability threshold **in** speech, keeps speech “latched” until confidence < this value. Lower = more tolerant.   |
| *(hysteresis)*            |                    — |      — | If `negative > positive`, values are automatically swapped to ensure correct behavior                                |
| `minSpeechFrames`         |    `number` (frames) |     `3` | Minimum consecutive **voice** frames (each 256 samples ≈ 16 ms) needed for speech start. `3` ≈ 48 ms.               |
| `minSilenceFrames`        |    `number` (frames) |     `8` | Minimum consecutive **non-voice** frames to consider speech ended                |
| `probSmoothing`           |      `number` (0..1) |   `0.2` | EMA smoothing of VAD probability. `0` = reacts instantly; `→1` = slow.                                               |
| `energyGateDb`            |   `number \| null`   |  `null` | RMS energy gate in **dBFS**. Frames below this are treated as silence; `null` disables.                              |
| `preEmphasis`             | `number` (~0..0.97)  |   `0.0` | Pre-emphasis for VAD only. Does **not** affect callback audio.                                                       |
| `preSpeechPadMs`          |      `number` (ms)   |    `80` | Leading context included at the start of each segment                                                                |
| `postSpeechPadMs`         |      `number` (ms)   |   `160` | Trailing context appended after speech ends (collected during silence) prior to segment finalize                     |
| `minSpeechMs`             |      `number` (ms)   |   `150` | Segments shorter than this are considered misfires → `onVADMisfire`                                                  |

## Notes & expectations

* **Input**: `processAudio(Float32Array)` at **16 kHz mono**, range `[-1, 1]`. Anything else throws.
* **Framing**: Fixed hop of **256 samples** (≈16 ms) internally.
* **System deps**: For microphone recording, you may require platform tools (Linux: `arecord`/`sox`, macOS: `sox`).
* **Lifecycle**: Call `flush()` to close in-progress segments (adds post-pad) before `destroy()`.
* **CLI demo/test:** See `test.js` and `record.js`. System microphone permissions/tools required.