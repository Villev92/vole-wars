// Most sounds are real recorded samples copied from designs/audio/ into public/audio/ under shorter
// names: the AK47, sniper, bazooka (fire + explosion), flamethrower loop, grenade (sokka/throw/
// bounce/explosion) and the vole grunts. playTerrainImpact() is still synthesized with the Web Audio
// API, matching the rest of the game's everything-procedural approach (terrain, character art).

let ctx: AudioContext | null = null;
// Every sound in this file routes through this single node rather than straight to
// audio.destination, so the volume slider (see main.ts) has one place to turn everything down at
// once instead of needing to know about each individual sound.
let masterGain: GainNode | null = null;

const VOLUME_STORAGE_KEY = "vole-wars-volume";
const DEFAULT_VOLUME = 0.7;

/** Reads the last-saved volume without needing an AudioContext to exist yet — used both as
 *  masterGain's own initial value and to initialize the slider's displayed position on page load,
 *  before any user gesture has created the context. */
function loadStoredVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
    if (raw === null) return DEFAULT_VOLUME;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME; // private browsing / storage disabled
  }
}

function getContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    masterGain = ctx.createGain();
    masterGain.gain.value = loadStoredVolume();
    masterGain.connect(ctx.destination);
  }
  return ctx;
}

/** Every playback function connects into this instead of ctx.destination directly. */
function getMasterGain(): GainNode {
  getContext();
  return masterGain!;
}

/** Unlocks the AudioContext on the first user gesture, satisfying browser autoplay policies, and
 *  warms the recorded-sample cache so the first play of each isn't stalled on a fetch+decode. */
export function unlockAudio(): void {
  const audio = getContext();
  if (audio.state === "suspended") void audio.resume();
  preloadSamples();
}

// Every recorded sample used in the game — preloaded on the first gesture (unlockAudio) so the
// first play of each has no fetch+decode latency. The flamethrower's is by far the biggest (~900KB).
const FLAME_URL = "/audio/flamethrower.mp3";
const PRELOAD_URLS = [
  FLAME_URL,
  "/audio/ak47.wav",
  "/audio/sniper.mp3",
  "/audio/bazooka-fire.wav",
  "/audio/bazooka-explosion.wav",
  "/audio/grunt.wav",
  "/audio/grunt-lower.wav",
  "/audio/grenade-sokka.wav",
  "/audio/grenade-throw.wav",
  "/audio/grenade-bounce.wav",
  "/audio/grenade-explosion.mp3",
];

/** Kicks off (and caches) the fetch+decode of every recorded sample, and — once decoded — spins up
 *  the (silent) looping flamethrower node so the first squeeze is instant. Idempotent; needs an
 *  AudioContext so only call it from a user gesture. */
export function preloadSamples(): void {
  getContext();
  for (const url of PRELOAD_URLS) void loadSample(url);
  void loadSample(FLAME_URL).then(() => ensureFlameNode());
}

/** Sets master volume (0-1) and remembers it for next time — dragging the slider is itself a user
 *  gesture, so this is also a fine place to lazily create the AudioContext on first interaction. */
export function setMasterVolume(volume: number): void {
  const clamped = Math.max(0, Math.min(1, volume));
  getMasterGain().gain.value = clamped;
  try {
    localStorage.setItem(VOLUME_STORAGE_KEY, String(clamped));
  } catch {
    // ignore — private browsing / storage disabled, volume just won't persist across reloads
  }
}

/** Current master volume (0-1) — reads the live gain node once audio has started, otherwise falls
 *  back to the saved/default value so the slider can show the right position before that. */
export function getMasterVolume(): number {
  return masterGain ? masterGain.gain.value : loadStoredVolume();
}

const sampleBuffers = new Map<string, Promise<AudioBuffer>>();
// Resolved buffers, so a play whose sample is already decoded (the common case after preload) can
// start SYNCHRONOUSLY instead of deferring to a promise microtask.
const decodedBuffers = new Map<string, AudioBuffer>();

/** Loads (and caches) a recorded sample by URL. Decoding needs an AudioContext, so this can't start
 *  before getContext() has been called at least once (unlockAudio, on the first user gesture). */
function loadSample(url: string): Promise<AudioBuffer> {
  let promise = sampleBuffers.get(url);
  if (!promise) {
    promise = fetch(url)
      .then((res) => res.arrayBuffer())
      .then((data) => getContext().decodeAudioData(data));
    void promise.then((buf) => decodedBuffers.set(url, buf)).catch(() => {});
    sampleBuffers.set(url, promise);
  }
  return promise;
}

function playBuffer(audio: AudioContext, buffer: AudioBuffer): void {
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(getMasterGain());
  source.start();
}

/** Plays a recorded sample by URL. Fire-and-forget: a new BufferSource per call so overlapping
 *  shots don't cut each other off. Starts synchronously when the sample is already decoded. */
function playSample(url: string): void {
  const audio = getContext();
  if (audio.state === "suspended") void audio.resume();
  const cached = decodedBuffers.get(url);
  if (cached) {
    playBuffer(audio, cached);
    return;
  }
  void loadSample(url).then((buffer) => playBuffer(audio, buffer));
}

export function playAkGunshot(): void {
  playSample("/audio/ak47.wav");
}

export function playSniperShot(): void {
  playSample("/audio/sniper.mp3");
}

export function playBazookaFire(): void {
  playSample("/audio/bazooka-fire.wav");
}

// The flamethrower fires continuously while held. Rather than start/stop a BufferSource per squeeze
// (which raced its own async load and dropped very short taps entirely), one looping source runs
// forever once the sample's decoded and a dedicated GainNode gates it: start ramps the gain to 1,
// stop ramps it back to 0. Gain changes are sample-accurate and synchronous, so the sound responds
// instantly, and FLAME_MIN_BLIP guarantees even an instant tap produces an audible puff.
const FLAME_ATTACK = 0.012; // gain ramp-up time constant (s)
const FLAME_RELEASE = 0.05; // gain ramp-down time constant (s)
const FLAME_MIN_BLIP = 0.12; // shortest audible burst, even for a 0ms tap
let flameWanted = false;
let flameSource: AudioBufferSourceNode | null = null;
let flameGain: GainNode | null = null;
let flameStartedAt = 0;

/** Creates and starts the (silent) looping flamethrower source+gain if the sample is decoded and it
 *  isn't already running. Returns whether the node now exists. */
function ensureFlameNode(): boolean {
  if (flameSource) return true;
  const buffer = decodedBuffers.get(FLAME_URL);
  if (!buffer) return false;
  const audio = getContext();
  const gain = audio.createGain();
  gain.gain.value = 0;
  gain.connect(getMasterGain());
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(gain);
  source.start();
  flameSource = source;
  flameGain = gain;
  return true;
}

/** Opens the flamethrower gain (fire started). */
export function startFlameLoop(): void {
  flameWanted = true;
  const audio = getContext();
  if (audio.state === "suspended") void audio.resume();
  if (!ensureFlameNode()) {
    // Sample not decoded yet (a fire before preload finished) — decode, then retry if still wanted.
    void loadSample(FLAME_URL).then(() => {
      if (flameWanted) startFlameLoop();
    });
    return;
  }
  const now = audio.currentTime;
  flameStartedAt = now;
  flameGain!.gain.cancelScheduledValues(now);
  flameGain!.gain.setTargetAtTime(1, now, FLAME_ATTACK);
}

/** Closes the flamethrower gain (fire released), but never before FLAME_MIN_BLIP has elapsed so a
 *  quick tap still gets heard. */
export function stopFlameLoop(): void {
  flameWanted = false;
  if (!flameGain) return;
  const now = getContext().currentTime;
  const rampAt = Math.max(now, flameStartedAt + FLAME_MIN_BLIP);
  flameGain.gain.setTargetAtTime(0, rampAt, FLAME_RELEASE);
}

/** Bazooka's own recorded blast, played instead of the generic synthesized playTerrainImpact()
 *  whenever what exploded was specifically a bazooka rocket (see main.ts's "terrain-carve" handler). */
export function playBazookaExplosion(): void {
  playSample("/audio/bazooka-explosion.wav");
}

// Recorded vole grunts — played on fire/fall damage, picked at random so it doesn't get repetitive.
// Just the low pair (Grunt.wav / GruntLower.wav); GruntHigh is deliberately not in the rotation.
const GRUNT_SAMPLES = ["/audio/grunt.wav", "/audio/grunt-lower.wav"];

/** Plays a random one of the vole grunts — the server fires this off (its "grunt" broadcast) when a
 *  vole takes flamethrower or fall damage. */
export function playGrunt(): void {
  playSample(GRUNT_SAMPLES[Math.floor(Math.random() * GRUNT_SAMPLES.length)]);
}

/** Grenade sounds — see main.ts / GameRoom: "sokka" when the charge starts, "throw" on release,
 *  "bounce" each time it caroms off terrain, "explosion" when it detonates. */
export function playGrenadeSokka(): void {
  playSample("/audio/grenade-sokka.wav");
}
export function playGrenadeThrow(): void {
  playSample("/audio/grenade-throw.wav");
}
export function playGrenadeBounce(): void {
  playSample("/audio/grenade-bounce.wav");
}
export function playGrenadeExplosion(): void {
  playSample("/audio/grenade-explosion.mp3");
}

/** Synthesized noise "crack" plus a short low thump — originally every weapon's firing sound, now
 *  repurposed as the terrain-impact sound (played when a bullet hits terrain and carves it away). */
export function playTerrainImpact(): void {
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

  noise.connect(bandpass).connect(noiseGain).connect(getMasterGain());

  // Low thump underneath for weight/body.
  const thump = audio.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(160, now);
  thump.frequency.exponentialRampToValueAtTime(40, now + 0.12);

  const thumpGain = audio.createGain();
  thumpGain.gain.setValueAtTime(0.7, now);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

  thump.connect(thumpGain).connect(getMasterGain());

  noise.start(now);
  noise.stop(now + duration + 0.02);
  thump.start(now);
  thump.stop(now + 0.16);
}
