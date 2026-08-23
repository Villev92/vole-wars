// No audio assets in this project — the shot sound is synthesized with the Web Audio API
// (a filtered noise "crack" plus a short low thump), matching the rest of the game's
// everything-procedural approach (terrain, character art).

let ctx: AudioContext | null = null;

function getContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

/** Unlocks the AudioContext on the first user gesture, satisfying browser autoplay policies. */
export function unlockAudio(): void {
  const audio = getContext();
  if (audio.state === "suspended") void audio.resume();
}

export function playGunshot(): void {
  const audio = getContext();
  if (audio.state === "suspended") void audio.resume();
  const now = audio.currentTime;

  // Noise burst run through a bandpass filter that sweeps downward — the "crack".
  const duration = 0.18;
  const bufferSize = Math.floor(audio.sampleRate * duration);
  const buffer = audio.createBuffer(1, bufferSize, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    const decay = 1 - i / bufferSize;
    data[i] = (Math.random() * 2 - 1) * decay * decay;
  }
  const noise = audio.createBufferSource();
  noise.buffer = buffer;

  const bandpass = audio.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.Q.value = 0.7;
  bandpass.frequency.setValueAtTime(1800, now);
  bandpass.frequency.exponentialRampToValueAtTime(300, now + duration);

  const noiseGain = audio.createGain();
  noiseGain.gain.setValueAtTime(0.9, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + duration);

  noise.connect(bandpass).connect(noiseGain).connect(audio.destination);

  // Low thump underneath for weight/body.
  const thump = audio.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(160, now);
  thump.frequency.exponentialRampToValueAtTime(40, now + 0.12);

  const thumpGain = audio.createGain();
  thumpGain.gain.setValueAtTime(0.7, now);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

  thump.connect(thumpGain).connect(audio.destination);

  noise.start(now);
  noise.stop(now + duration + 0.02);
  thump.start(now);
  thump.stop(now + 0.16);
}
