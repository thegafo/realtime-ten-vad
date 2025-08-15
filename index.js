#!/usr/bin/env node
'use strict';

/**
 * TEN VAD – Realtime class API (Node.js)
 * - processAudio(Float32Array) consumes 16 kHz mono floats
 * - Internally frames at 256 samples (16 ms) and calls TEN VAD (WASM)
 * - Emits onSpeechStart / onSpeechEnd(Float32Array) / onVADMisfire()
 *
 * System deps:
 *   Linux: arecord/sox  |  macOS: sox
 */

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 16000;
const HOP_SIZE = 256; // 16 ms @ 16 kHz
const WASM_DIR = path.resolve(__dirname, './lib');
const WASM_JS_FILE = path.join(WASM_DIR, 'ten_vad.js');
const WASM_BINARY_FILE = path.join(WASM_DIR, 'ten_vad.wasm');

class RealtimeTenVad {
  // Async factory to mirror your example API
  static async new(opts = {}) {
    const vad = new RealtimeTenVad(opts);
    await vad._loadVADModule();
    return vad;
  }

  constructor(opts = {}) {
    // Callbacks
    this.onSpeechStart = opts.onSpeechStart || (() => { });
    this.onSpeechEnd = opts.onSpeechEnd || (() => { });
    this.onVADMisfire = opts.onVADMisfire || (() => { });

    // Tunables / knobs (sane defaults)
    let pos = Number(opts.positiveSpeechThreshold ?? 0.6);
    let neg = Number(opts.negativeSpeechThreshold ?? 0.4);
    pos = Math.min(1, Math.max(0, pos));
    neg = Math.min(1, Math.max(0, neg));
    if (neg > pos) [pos, neg] = [neg, pos]; // ensure hysteresis is well-ordered
    this.positiveSpeechThreshold = pos;
    this.negativeSpeechThreshold = neg;

    this.minSpeechFrames = Number(opts.minSpeechFrames ?? 3);   // ~48 ms
    this.minSilenceFrames = Number(opts.minSilenceFrames ?? 8); // ~128 ms
    this.probSmoothing = Math.min(1, Math.max(0, Number(opts.probSmoothing ?? 0.2))); // 0..1 EMA
    this.energyGateDb = (opts.energyGateDb === null || opts.energyGateDb === undefined)
      ? null  // null disables gate
      : Number(opts.energyGateDb);
    this.preEmphasis = Number(opts.preEmphasis ?? 0.0);         // 0 to ~0.97
    this.preSpeechPadMs = Number(opts.preSpeechPadMs ?? 80);    // leading context
    this.postSpeechPadMs = Number(opts.postSpeechPadMs ?? 160); // trailing context
    this.minSpeechMs = Number(opts.minSpeechMs ?? 150);         // misfire threshold

    // Internal state
    this._module = null;
    this._handle = null;
    this._handlePtr = null;

    this._floatBuf = new Float32Array(0); // buffer input until we have a frame
    this._lastSampleForPreEmph = 0.0;     // previous raw sample for pre-emphasis

    // EMA smoothing for probability
    this._pSmoothed = 0;

    // Frame-wise state machine
    this._frameIndex = 0;
    this._inSpeech = false;
    this._voiceRun = 0;
    this._silenceRun = 0;

    // Segment audio buffers (unmodified Float32 views)
    this._prePadFrames = Math.round((this.preSpeechPadMs / 1000) * SAMPLE_RATE / HOP_SIZE);
    this._postPadFrames = Math.round((this.postSpeechPadMs / 1000) * SAMPLE_RATE / HOP_SIZE);

    this._ring = []; // ring of last N frames for pre-pad (stores views, not copies)
    this._ringMax = Math.max(0, this._prePadFrames);
    this._currentSegment = []; // frames while in speech (views)
    this._postPadCountdown = 0;

    // Reusable work buffers and wasm pointers
    this._int16Frame = new Int16Array(HOP_SIZE);
    this._audioPtr = null;
    this._probPtr = null;
    this._flagPtr = null;
  }

  // ==========================
  // Public API
  // ==========================
  processAudio(floatChunk) {
    // Accept Float32Array at 16 kHz mono, range [-1, 1]
    if (!(floatChunk instanceof Float32Array)) {
      throw new Error('processAudio expects Float32Array');
    }
    // Append to buffer
    const combined = new Float32Array(this._floatBuf.length + floatChunk.length);
    combined.set(this._floatBuf, 0);
    combined.set(floatChunk, this._floatBuf.length);

    // Frame off in 256-sample hops
    const frames = Math.floor(combined.length / HOP_SIZE);
    for (let i = 0; i < frames; i++) {
      const start = i * HOP_SIZE;
      const end = start + HOP_SIZE;
      const frameRaw = combined.subarray(start, end); // view on combined (unchanged)

      // Process frame (pre-emphasis is applied only to what goes into WASM)
      this._processFrame(frameRaw);
    }
    // Remainder
    this._floatBuf = combined.subarray(frames * HOP_SIZE);
  }

  flush() {
    // Process any leftover samples (zero-pad to one frame if needed)
    if (this._floatBuf.length > 0) {
      const pad = new Float32Array(HOP_SIZE);
      pad.set(this._floatBuf, 0);
      this.processAudio(pad);
      this._floatBuf = new Float32Array(0);
    }
    // If we’re still in a segment, force-close it with post padding
    if (this._inSpeech) {
      this._postPadCountdown = this._postPadFrames;
      while (this._postPadCountdown > 0) {
        // push silent frames as tail
        const silent = new Float32Array(HOP_SIZE);
        this._finalizeWithFrame(silent, /*treatAsSilence*/ true);
      }
    }
  }

  destroy() {
    try {
      if (this._module) {
        if (this._audioPtr) this._module._free(this._audioPtr);
        if (this._probPtr) this._module._free(this._probPtr);
        if (this._flagPtr) this._module._free(this._flagPtr);
        if (this._handle) this._module._ten_vad_destroy(this._handle); // FIX: pass handle, not pointer
        if (this._handlePtr) this._module._free(this._handlePtr);
      }
    } catch (_) { }
    this._module = null;
    this._handle = null;
    this._handlePtr = null;
  }

  // ==========================
  // Internals
  // ==========================
  async _loadVADModule() {
    if (!fs.existsSync(WASM_JS_FILE)) throw new Error(`Missing ${WASM_JS_FILE}`);
    if (!fs.existsSync(WASM_BINARY_FILE)) throw new Error(`Missing ${WASM_BINARY_FILE}`);

    // Patch ESM → CJS for Node
    const js = fs.readFileSync(WASM_JS_FILE, 'utf8')
      .replace(/import\.meta\.url/g, `"${path.resolve(WASM_JS_FILE)}"`)
      .replace(/export default [a-zA-Z_][\w$]*/g, 'module.exports = createVADModule');
    const tempPath = path.join(__dirname, '.ten_vad_temp.js');
    fs.writeFileSync(tempPath, js);

    const wasmBinary = fs.readFileSync(WASM_BINARY_FILE);
    const createVADModule = require(tempPath);
    this._module = await createVADModule({
      wasmBinary,
      locateFile: (p) => (p.endsWith('.wasm') ? WASM_BINARY_FILE : p),
      noInitialRun: false,
      noExitRuntime: true
    });
    fs.unlinkSync(tempPath);

    // Helper sometimes missing on certain builds
    if (!this._module.getValue) {
      this._module.getValue = (ptr, type) => {
        switch (type) {
          case 'i32': return this._module.HEAP32[ptr >> 2];
          case 'float': return this._module.HEAPF32[ptr >> 2];
          default: throw new Error(`Unsupported type: ${type}`);
        }
      };
    }

    // Create VAD instance
    this._handlePtr = this._module._malloc(4);
    const rc = this._module._ten_vad_create(this._handlePtr, HOP_SIZE, /*VOICE_THRESHOLD (may be unused)*/ 0.5);
    if (rc !== 0) {
      this._module._free(this._handlePtr);
      this._handlePtr = null;
      throw new Error(`_ten_vad_create failed: ${rc}`);
    }
    this._handle = this._module.getValue(this._handlePtr, 'i32');

    // Reusable Wasm pointers
    this._audioPtr = this._module._malloc(HOP_SIZE * 2);
    this._probPtr = this._module._malloc(4);
    this._flagPtr = this._module._malloc(4);
  }

  _processFrame(frameRaw /* Float32Array view, length HOP_SIZE */) {
    // Convert Float32 [-1,1] → Int16 for the WASM call, applying optional pre-emphasis on the fly
    let prev = this._lastSampleForPreEmph;
    if (this.preEmphasis > 0) {
      const a = this.preEmphasis;
      for (let i = 0; i < HOP_SIZE; i++) {
        const x = frameRaw[i];
        const y = x - a * prev;               // pre-emphasis for VAD only
        prev = x;                             // carry raw sample
        const s = Math.max(-1, Math.min(1, y));
        this._int16Frame[i] = (s * 32768) | 0;
      }
    } else {
      for (let i = 0; i < HOP_SIZE; i++) {
        const x = frameRaw[i];
        const s = Math.max(-1, Math.min(1, x));
        this._int16Frame[i] = (s * 32768) | 0;
      }
      prev = frameRaw[HOP_SIZE - 1];
    }
    this._lastSampleForPreEmph = prev;

    // Copy into HEAP and run VAD
    this._module.HEAP16.set(this._int16Frame, this._audioPtr >> 1);
    const rc = this._module._ten_vad_process(this._handle, this._audioPtr, HOP_SIZE, this._probPtr, this._flagPtr);
    if (rc !== 0) {
      // treat as non-voice frame on error
      this._advanceState(false, 0, frameRaw);
      return;
    }

    const p = this._module.getValue(this._probPtr, 'float');
    const flag = this._module.getValue(this._flagPtr, 'i32'); // 0/1

    // Probability smoothing (EMA)
    const alpha = this.probSmoothing; // already clamped 0..1
    this._pSmoothed = alpha * this._pSmoothed + (1 - alpha) * p;

    // Energy gate (in dBFS) — compute on raw (unmodified) audio
    let gated = true;
    if (this.energyGateDb !== null) {
      let sum = 0;
      for (let i = 0; i < HOP_SIZE; i++) sum += frameRaw[i] * frameRaw[i];
      const rms = Math.sqrt(sum / HOP_SIZE) + 1e-12;
      const db = 20 * Math.log10(rms); // 0 dBFS ~ full scale
      gated = (db >= this.energyGateDb);
    }

    const hysteresisThresh = this._inSpeech ? this.negativeSpeechThreshold : this.positiveSpeechThreshold;
    const isVoice = (flag === 1) && (this._pSmoothed >= hysteresisThresh) && gated;

    this._advanceState(isVoice, this._pSmoothed, frameRaw);
  }

  _advanceState(isVoice, prob, frameRaw /* view */) {
    // Maintain ring buffer for pre-pad (store views to avoid per-frame copies)
    if (this._ringMax > 0) {
      if (this._ring.length >= this._ringMax) this._ring.shift();
      this._ring.push(frameRaw);
    }

    if (isVoice) {
      this._voiceRun++;
      this._silenceRun = 0;

      // Enter speech?
      if (!this._inSpeech && this._voiceRun >= this.minSpeechFrames) {
        this._inSpeech = true;

        // Seed current segment with pre-pad frames
        if (this._ringMax > 0) {
          for (const f of this._ring) this._currentSegment.push(f);
        }
        this._postPadCountdown = 0;
        try { this.onSpeechStart(); } catch (_) { }
      }

      // Accumulate frames while in speech
      if (this._inSpeech) this._currentSegment.push(frameRaw);

    } else {
      this._silenceRun++;
      this._voiceRun = 0;

      if (this._inSpeech) {
        // Count down post padding while silent
        if (this._postPadCountdown === 0) {
          // Start counting once we FIRST hit silence
          this._postPadCountdown = this._postPadFrames;
        }
        this._currentSegment.push(frameRaw);
        this._postPadCountdown--;

        // Finalize once enough trailing silence collected
        if (this._silenceRun >= this.minSilenceFrames && this._postPadCountdown <= 0) {
          const seg = this._concatFrames(this._currentSegment);
          const durMs = Math.round(seg.length / SAMPLE_RATE * 1000);

          this._inSpeech = false;
          this._currentSegment = [];
          this._postPadCountdown = 0;

          if (durMs < this.minSpeechMs) {
            try { this.onVADMisfire(); } catch (_) { }
          } else {
            try { this.onSpeechEnd(seg); } catch (_) { }
          }
        }
      }
    }

    this._frameIndex++;
  }

  _finalizeWithFrame(trailingFrame, treatAsSilence) {
    // Helper used during flush()
    this._currentSegment.push(trailingFrame);
    if (treatAsSilence) {
      if (this._postPadCountdown === 0) this._postPadCountdown = this._postPadFrames;
      this._postPadCountdown--;
      if (this._postPadCountdown <= 0) {
        const seg = this._concatFrames(this._currentSegment);
        const durMs = Math.round(seg.length / SAMPLE_RATE * 1000);
        this._inSpeech = false;
        this._currentSegment = [];
        this._postPadCountdown = 0;
        if (durMs < this.minSpeechMs) {
          try { this.onVADMisfire(); } catch (_) { }
        } else {
          try { this.onSpeechEnd(seg); } catch (_) { }
        }
      }
    }
  }

  _concatFrames(frames) {
    const out = new Float32Array(frames.length * HOP_SIZE);
    let off = 0;
    for (const f of frames) {
      out.set(f, off);
      off += f.length;
    }
    return out;
  }
}

module.exports = { RealtimeTenVad };
