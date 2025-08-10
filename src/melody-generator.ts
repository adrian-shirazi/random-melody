import fs from "fs";
import path from "path";
import MidiWriter from "midi-writer-js";

interface Params {
  measures: number;
  tempo: number;
  seed?: string;
  lowMidi: number;
  highMidi: number;
}
interface Note {
  midi: number;
  name: string;
  startBeats: number;
  durationBeats: number;
}

// -------------------- Seeded RNG (Mulberry32) --------------------
function xmur3(str: string) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makePRNG(seed?: string) {
  if (!seed) return Math.random;
  const seedFn = xmur3(seed);
  return mulberry32(seedFn());
}

const SHARP_NOTE_ORDER = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;
function midiToName(midi: number): string {
  const pc = midi % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${SHARP_NOTE_ORDER[pc]}${octave}`;
}
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

// -------------------- Rhythm generation --------------------
// Measure length is 1.0 (a whole note). Values are fractions of a whole.
// Example pool: whole=1.0, half=0.5, quarter=0.25, eighth=0.125, sixteenth=0.0625
const RHYTHM_POOL = [1.0, 0.5, 0.25, 0.125, 0.0625];

function generateMeasureDurations(
  rand: () => number,
  pool = RHYTHM_POOL
): number[] {
  const durations: number[] = [];
  const EPS = 1e-6;
  let used = 0;
  while (used < 1 - EPS) {
    // filter to values that can still fit
    const remaining = 1 - used;
    const candidates = pool.filter((v) => v <= remaining + EPS);
    if (candidates.length === 0) {
      // numerical safety net
      durations.push(remaining);
      break;
    }
    const idx = Math.floor(rand() * candidates.length);
    const val = candidates[idx];
    durations.push(val);
    used += val;
  }
  // snap final sum to exactly 1.0 to avoid drift
  const sum = durations.reduce((a, b) => a + b, 0);
  const diff = 1 - sum;
  if (Math.abs(diff) > EPS) durations[durations.length - 1] += diff;
  return durations;
}

// -------------------- Pitch generation (no key/mode) --------------------
// Mostly stepwise motion (±1–2 semitones), occasional leap (±5 or ±7)
function nextMidi(
  rand: () => number,
  current: number,
  low: number,
  high: number
): number {
  const stepProb = 0.8;
  let delta: number;
  if (rand() < stepProb) {
    const choices = [-2, -1, 1, 2];
    delta = choices[Math.floor(rand() * choices.length)];
  } else {
    const leaps = [-7, -5, 5, 7];
    delta = leaps[Math.floor(rand() * leaps.length)];
  }
  let candidate = current + delta;
  if (candidate < low || candidate > high) {
    // reflect back into range
    candidate = clamp(candidate, low, high);
  }
  return candidate;
}

// -------------------- Melody generation --------------------
function generateMelody(params: Params): Note[] {
  const rand = makePRNG(params.seed);
  const events: Note[] = [];
  let tBeats = 0; // 1.0 whole note == 4 beats, so convert later

  // start near middle C (60) clamped to range
  let currentMidi = clamp(60, params.lowMidi, params.highMidi);

  for (let bar = 0; bar < params.measures; bar++) {
    const dursWholeFractions = generateMeasureDurations(rand);
    for (const frac of dursWholeFractions) {
      currentMidi = nextMidi(
        rand,
        currentMidi,
        params.lowMidi,
        params.highMidi
      );
      const durationBeats = frac * 4; // convert whole-fraction to beats (4/4)
      events.push({
        midi: currentMidi,
        name: midiToName(currentMidi),
        startBeats: tBeats,
        durationBeats,
      });
      tBeats += durationBeats;
    }
  }
  return events;
}

// -------------------- CLI + MIDI export --------------------
function parseArgs(): Params {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .map((s) =>
        s.replace(/^--/, "").split("=").length === 2
          ? s.replace(/^--/, "").split("=")
          : s.startsWith("--")
          ? [s.replace(/^--/, ""), "true"]
          : [s, "true"]
      )
  ) as Record<string, string>;
  const measures = parseInt(args.measures ?? "4", 10);
  const tempo = parseInt(args.tempo ?? "100", 10);
  const seed = args.seed || undefined;
  const lowMidi = parseInt(args.lowMidi ?? "55", 10); // G3
  const highMidi = parseInt(args.highMidi ?? "76", 10); // E5
  return { measures, tempo, seed, lowMidi, highMidi };
}

function beatsToDurationString(beats: number): string {
  const map: Record<string, string> = {
    "0": "T0",
    "0.5": "8",
    "1": "4",
    "1.5": "d4",
    "2": "2",
    "3": "d2",
    "4": "1",
  };
  if (map[String(beats)]) return map[String(beats)];
  const ticks = Math.round(beats * 128);
  return `T${ticks}`;
}

function writeMidi(events: Note[], tempo: number, outPath: string) {
  const track = new MidiWriter.Track();
  track.setTempo(tempo);
  track.addTrackName("Random Melody (no key)");
  let lastStart = 0;
  for (const ev of events) {
    const waitBeats = ev.startBeats - lastStart;
    lastStart = ev.startBeats;
    const note = new MidiWriter.NoteEvent({
      pitch: [ev.name],
      duration: beatsToDurationString(ev.durationBeats),
      wait: beatsToDurationString(waitBeats),
    } as any);
    track.addEvent(note);
  }
  const writer = new MidiWriter.Writer([track]);
  fs.writeFileSync(outPath, Buffer.from(writer.buildFile()));
}

if (require.main === module) {
  const params = parseArgs();
  const melody = generateMelody(params);
  const summary = {
    params,
    notes: melody.map((n) => ({
      name: n.name,
      start: n.startBeats,
      dur: n.durationBeats,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
  const out = path.resolve(process.cwd(), "out.mid");
  writeMidi(melody, params.tempo, out);
  console.log(`
Wrote MIDI -> ${out}`);
}
