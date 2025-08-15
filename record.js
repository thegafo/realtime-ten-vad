const fs = require('fs');
const path = require('path');
const Mic = require('node-microphone');
const { RealtimeTenVad } = require('.');

// Utility to encode Float32Array audio to PCM16LE WAV
function encodeWav(float32audio, sampleRate = 16000) {
  const numSamples = float32audio.length;
  const buffer = Buffer.alloc(44 + numSamples * 2);
  // WAV Header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4); // file size - 8
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // subchunk1 size
  buffer.writeUInt16LE(1, 20);  // audio format PCM
  buffer.writeUInt16LE(1, 22);  // num channels
  buffer.writeUInt32LE(sampleRate, 24); // sample rate
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);
  // PCM16LE
  for (let i = 0; i < numSamples; ++i) {
    let s = Math.max(-1, Math.min(1, float32audio[i]));
    buffer.writeInt16LE(Math.floor(s * 32767), 44 + i * 2);
  }
  return buffer;
}

(async () => {
  const vad = await RealtimeTenVad.new({
    onSpeechStart: () => console.log('Speech started'),
    onSpeechEnd: (audio) => {
      const durationSeconds = audio.length / 16000;
      console.log('Speech ended, audio duration (seconds):', durationSeconds.toFixed(2));
      // Save to .wav file on audio detection
      try {
        const wavBuffer = encodeWav(audio, 16000);
        if (!fs.existsSync('audio')) fs.mkdirSync('audio');
        const outPath = path.join('audio', `speech_${Date.now()}.wav`);
        fs.writeFileSync(outPath, wavBuffer);
        console.log(`Saved audio to ${outPath}`);
      } catch (err) {
        console.error('Failed to save wav:', err);
      }
    },
    onVADMisfire: () => console.log('VAD misfire detected'),

    // --- Tunables you can tweak ---
    positiveSpeechThreshold: 0.6,
    negativeSpeechThreshold: 0.4,
    minSpeechFrames: 10,
    minSilenceFrames: 15,
    probSmoothing: 0.2,
    energyGateDb: -55,   // set to null to disable gating
    preEmphasis: 0.0,    // try 0.97 for noisy mics/environments
    preSpeechPadMs: 80,
    postSpeechPadMs: 160,
    minSpeechMs: 150
  });

  // 16 kHz, mono, 16-bit signed PCM, little-endian
  const mic = new Mic({
    rate: 16000,
    channels: 1,
    bitwidth: 16,
    encoding: 'signed-integer',
    device: process.env.MIC_DEVICE || null,
    useDataEmitter: true
  });

  const micStream = mic.startRecording();
  console.log('Listening... (Ctrl+C to stop)');

  micStream.on('data', async (chunk) => {
    // Convert PCM16LE Buffer -> Float32Array [-1, 1]
    const floatData = new Float32Array(chunk.length / 2);
    for (let i = 0; i < chunk.length; i += 2) {
      floatData[i >> 1] = chunk.readInt16LE(i) / 32768;
    }
    await vad.processAudio(floatData);
  });

  const cleanup = async () => {
    await vad.flush();
    vad.destroy();
    try { mic.stopRecording(); } catch (_) { }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
})().catch((err) => {
  console.error('Fatal:', err?.message || err);
  process.exit(1);
});
