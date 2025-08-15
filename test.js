const Mic = require('node-microphone');
const { RealtimeTenVad } = require('.');

(async () => {
  const vad = await RealtimeTenVad.new({
    onSpeechStart: () => console.log('Speech started'),
    onSpeechEnd: (audio) => {
      const durationSeconds = audio.length / 16000;
      console.log('Speech ended, audio duration (seconds):', durationSeconds.toFixed(2));
      // e.g., save or analyze: Float32Array @ 16 kHz
    },
    onVADMisfire: () => console.log('VAD misfire detected'),

    // --- Tunables you can tweak ---
    positiveSpeechThreshold: 0.7,
    negativeSpeechThreshold: 0.4,
    minSpeechFrames: 5,
    minSilenceFrames: 10,
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