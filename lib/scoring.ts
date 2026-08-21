import type { PerformanceResult, ScoreBreakdown } from "./types";

export type PitchReading = { frequency: number; confidence: number };
export type RhythmReference = { beatTimes: number[] };

export type ScoreAccumulator = {
  voicedSeconds: number;
  pitches: number[];
  energies: number[];
  confidences: number[];
  smoothTransitions: number;
  transitions: number;
  clippedFrames: number;
  voicedFrames: number;
  vocalEvents: number[];
  lastVoicedAt: number | null;
  lastEventAt: number | null;
  lastEventPitch: number | null;
};

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const round = (value: number) => Math.round(value);

export function calculateRms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

export function detectPitch(samples: Float32Array, sampleRate: number): PitchReading {
  const rms = calculateRms(samples);
  if (rms < 0.008) return { frequency: 0, confidence: 0 };

  const minLag = Math.floor(sampleRate / 1000);
  const maxLag = Math.min(Math.floor(sampleRate / 75), samples.length - 1);
  let bestLag = 0;
  let bestCorrelation = -1;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let numerator = 0;
    let leftPower = 0;
    let rightPower = 0;
    const size = samples.length - lag;
    for (let index = 0; index < size; index += 1) {
      const left = samples[index];
      const right = samples[index + lag];
      numerator += left * right;
      leftPower += left * left;
      rightPower += right * right;
    }
    const denominator = Math.sqrt(leftPower * rightPower);
    const correlation = denominator > 0 ? numerator / denominator : 0;
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  return bestLag > 0 && bestCorrelation > 0.45
    ? { frequency: sampleRate / bestLag, confidence: clamp(bestCorrelation) }
    : { frequency: 0, confidence: 0 };
}

export function createAccumulator(): ScoreAccumulator {
  return {
    voicedSeconds: 0,
    pitches: [],
    energies: [],
    confidences: [],
    smoothTransitions: 0,
    transitions: 0,
    clippedFrames: 0,
    voicedFrames: 0,
    vocalEvents: [],
    lastVoicedAt: null,
    lastEventAt: null,
    lastEventPitch: null,
  };
}

export function recordVoicedFrame(
  accumulator: ScoreAccumulator,
  frame: { frequency: number; confidence: number; rms: number; seconds: number; clipped: boolean; at?: number },
): void {
  const previousPitch = accumulator.pitches.at(-1);
  const at = Math.max(0, frame.at ?? accumulator.voicedSeconds);
  if (previousPitch) {
    const cents = Math.abs(1200 * Math.log2(frame.frequency / previousPitch));
    accumulator.transitions += 1;
    if (cents <= 350) accumulator.smoothTransitions += 1;
  }

  const isNewPhrase = accumulator.lastVoicedAt === null || at - accumulator.lastVoicedAt >= 0.28;
  const centsSinceEvent = accumulator.lastEventPitch
    ? Math.abs(1200 * Math.log2(frame.frequency / accumulator.lastEventPitch))
    : 0;
  const isNewNote = centsSinceEvent >= 180 && (accumulator.lastEventAt === null || at - accumulator.lastEventAt >= 0.18);
  if (isNewPhrase || isNewNote) {
    accumulator.vocalEvents.push(at);
    accumulator.lastEventAt = at;
    accumulator.lastEventPitch = frame.frequency;
  }

  accumulator.voicedSeconds += clamp(frame.seconds, 0, 0.15);
  accumulator.pitches.push(frame.frequency);
  accumulator.energies.push(frame.rms);
  accumulator.confidences.push(frame.confidence);
  accumulator.voicedFrames += 1;
  if (frame.clipped) accumulator.clippedFrames += 1;
  accumulator.lastVoicedAt = at;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], point: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(point * sorted.length))];
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function cadenceRatio(accumulator: ScoreAccumulator, pitchRange: number): number {
  if (accumulator.voicedSeconds <= 0) return 0;
  const eventRate = accumulator.vocalEvents.length / accumulator.voicedSeconds;
  const phraseRatio = clamp(eventRate / 0.35) * clamp(1 - Math.max(0, eventRate - 4) / 4);
  const pitchMovement = clamp((pitchRange - 1.5) / 7) * clamp(1 - Math.max(0, pitchRange - 24) / 16);
  return clamp(pitchMovement * 0.65 + phraseRatio * 0.35);
}

function rhythmRatio(vocalEvents: number[], beatTimes: number[]): number | null {
  if (vocalEvents.length < 3 || beatTimes.length < 5) return null;
  const sortedBeats = [...beatTimes].sort((a, b) => a - b);
  const beatLength = median(
    sortedBeats
      .slice(1)
      .map((beat, index) => beat - sortedBeats[index])
      .filter((interval) => interval >= 0.24 && interval <= 1.2),
  );
  if (!beatLength) return null;

  const pulses = new Set<number>();
  for (const beat of sortedBeats) {
    pulses.add(Math.round(beat * 1000));
    pulses.add(Math.round((beat + beatLength / 2) * 1000));
  }
  const pulseTimes = [...pulses].map((pulse) => pulse / 1000);
  const tolerance = Math.min(0.18, beatLength * 0.32);
  const aligned = vocalEvents.map((event) => {
    const distance = pulseTimes.reduce((closest, pulse) => Math.min(closest, Math.abs(event - pulse)), Infinity);
    return clamp(1 - distance / tolerance);
  });
  return mean(aligned);
}

export function scorePerformance(accumulator: ScoreAccumulator, rhythm?: RhythmReference): PerformanceResult {
  const presenceRatio = clamp(accumulator.voicedSeconds / 60);
  const averageConfidence = mean(accumulator.confidences);
  const smoothRatio = accumulator.transitions
    ? accumulator.smoothTransitions / accumulator.transitions
    : 0;

  const energyMean = mean(accumulator.energies);
  const energyVariance = mean(accumulator.energies.map((value) => (value - energyMean) ** 2));
  const energyCv = energyMean > 0 ? Math.sqrt(energyVariance) / energyMean : 2;
  const clippingRatio = accumulator.voicedFrames
    ? accumulator.clippedFrames / accumulator.voicedFrames
    : 1;

  const lowPitch = percentile(accumulator.pitches, 0.1);
  const highPitch = percentile(accumulator.pitches, 0.9);
  const pitchRange = lowPitch > 0 ? 12 * Math.log2(highPitch / lowPitch) : 0;
  const controlRatio = clamp(averageConfidence * 0.65 + smoothRatio * 0.35);
  const consistencyRatio = clamp(1 - energyCv / 1.25) * clamp(1 - clippingRatio * 3);
  const fallbackMusicality = cadenceRatio(accumulator, pitchRange);
  const timingRatio = rhythm ? rhythmRatio(accumulator.vocalEvents, rhythm.beatTimes) : null;
  const musicalityRatio = timingRatio === null
    ? fallbackMusicality
    : clamp(timingRatio * 0.75 + fallbackMusicality * 0.25);

  const breakdown: ScoreBreakdown = {
    presence: round(presenceRatio * 20),
    control: round(controlRatio * 30),
    consistency: round(consistencyRatio * 25),
    expressiveness: round(musicalityRatio * 25),
  };
  const score = Math.min(100, Object.values(breakdown).reduce((sum, value) => sum + value, 0));

  return {
    valid: accumulator.voicedSeconds >= 15,
    score,
    breakdown,
    voicedSeconds: Math.round(accumulator.voicedSeconds * 10) / 10,
  };
}

export function getLiveMetrics(accumulator: ScoreAccumulator) {
  const result = scorePerformance(accumulator);
  return {
    presence: Math.min(100, Math.round((accumulator.voicedSeconds / 60) * 100)),
    control: Math.round((result.breakdown.control / 30) * 100),
    energy: Math.round((result.breakdown.consistency / 25) * 100),
  };
}
