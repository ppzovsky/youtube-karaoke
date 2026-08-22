import {
  calculateRms,
  createAccumulator,
  detectPitch,
  getLiveMetrics,
  recordVoicedFrame,
  scorePerformance,
  type ScoreAccumulator,
} from "./scoring";
import type { PerformanceResult } from "./types";

export type LiveMetrics = { presence: number; control: number; energy: number; voicedSeconds: number };

export class VoiceSession {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private rhythmSource: MediaStreamAudioSourceNode | null = null;
  private rhythmAnalyser: AnalyserNode | null = null;
  private rhythmBins: Uint8Array<ArrayBuffer> | null = null;
  private timer: number | null = null;
  private lastFrameAt = 0;
  private startedAt = 0;
  private noiseFloor = 0.012;
  private accumulator: ScoreAccumulator = createAccumulator();
  private beatTimes: number[] = [];
  private recentRhythmEnergy: number[] = [];
  private previousRhythmEnergy = 0;
  private lastBeatAt = -Infinity;

  async prepare(onCalibration: (progress: number) => void): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Este navegador não oferece acesso ao microfone.");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.context = new AudioContext();
    if (this.context.state === "suspended") await this.context.resume();
    const source = this.context.createMediaStreamSource(this.stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.2;
    source.connect(this.analyser);
    this.samples = new Float32Array(this.analyser.fftSize);

    const readings: number[] = [];
    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
      const sample = () => {
        if (!this.analyser || !this.samples) return resolve();
        this.analyser.getFloatTimeDomainData(this.samples);
        readings.push(calculateRms(this.samples));
        const progress = Math.min(1, (performance.now() - startedAt) / 3000);
        onCalibration(progress);
        if (progress >= 1) return resolve();
        window.setTimeout(sample, 80);
      };
      sample();
    });
    const averageNoise = readings.length
      ? readings.reduce((sum, value) => sum + value, 0) / readings.length
      : 0.012;
    this.noiseFloor = Math.max(0.012, averageNoise);
  }

  enableRhythmAnalysis(stream: MediaStream | null): boolean {
    if (!this.context || !stream?.getAudioTracks().some((track) => track.readyState === "live")) return false;
    this.stopRhythmAnalysis();
    const source = this.context.createMediaStreamSource(stream);
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.25;
    source.connect(analyser);
    this.rhythmSource = source;
    this.rhythmAnalyser = analyser;
    this.rhythmBins = new Uint8Array(analyser.frequencyBinCount);
    return true;
  }

  start(onMetrics: (metrics: LiveMetrics) => void): void {
    if (!this.context || !this.analyser || !this.samples) throw new Error("Microfone não preparado.");
    this.accumulator = createAccumulator();
    this.lastFrameAt = performance.now();
    this.startedAt = this.lastFrameAt;
    this.beatTimes = [];
    this.recentRhythmEnergy = [];
    this.previousRhythmEnergy = 0;
    this.lastBeatAt = -Infinity;
    this.timer = window.setInterval(() => {
      if (!this.analyser || !this.samples || !this.context) return;
      const now = performance.now();
      const elapsed = Math.min(0.15, (now - this.lastFrameAt) / 1000);
      this.lastFrameAt = now;
      this.analyser.getFloatTimeDomainData(this.samples);
      const rms = calculateRms(this.samples);
      const peak = this.samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
      const pitch = detectPitch(this.samples, this.context.sampleRate);
      const at = (now - this.startedAt) / 1000;
      const voiceThreshold = Math.max(0.018, this.noiseFloor * 2.35);
      if (rms >= voiceThreshold && pitch.frequency >= 75 && pitch.frequency <= 1000 && pitch.confidence >= 0.52) {
        recordVoicedFrame(this.accumulator, {
          frequency: pitch.frequency,
          confidence: pitch.confidence,
          rms,
          seconds: elapsed,
          clipped: peak >= 0.97,
          at,
        });
      }
      this.collectBeat(at);
      const live = getLiveMetrics(this.accumulator);
      onMetrics({ ...live, voicedSeconds: this.accumulator.voicedSeconds });
    }, 50);
  }

  finish(): PerformanceResult {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    const result = scorePerformance(this.accumulator, this.beatTimes.length >= 5 ? { beatTimes: this.beatTimes } : undefined);
    this.dispose();
    return result;
  }

  cancel(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.dispose();
  }

  private dispose(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.stream = null;
    this.context = null;
    this.analyser = null;
    this.samples = null;
    this.stopRhythmAnalysis();
  }

  private collectBeat(at: number): void {
    if (!this.rhythmAnalyser || !this.rhythmBins) return;
    this.rhythmAnalyser.getByteFrequencyData(this.rhythmBins);
    const lowFrequencyBins = Math.min(24, this.rhythmBins.length);
    const energy = lowFrequencyBins
      ? this.rhythmBins.slice(0, lowFrequencyBins).reduce((sum, value) => sum + value, 0) / lowFrequencyBins
      : 0;
    this.recentRhythmEnergy.push(energy);
    if (this.recentRhythmEnergy.length > 24) this.recentRhythmEnergy.shift();
    const baseline = this.recentRhythmEnergy.length
      ? this.recentRhythmEnergy.reduce((sum, value) => sum + value, 0) / this.recentRhythmEnergy.length
      : 0;
    const isPeak = this.recentRhythmEnergy.length >= 8
      && energy > baseline * 1.18
      && energy - this.previousRhythmEnergy > 5
      && at - this.lastBeatAt >= 0.24;
    if (isPeak) {
      this.beatTimes.push(at);
      this.lastBeatAt = at;
    }
    this.previousRhythmEnergy = energy;
  }

  private stopRhythmAnalysis(): void {
    this.rhythmSource?.disconnect();
    this.rhythmAnalyser?.disconnect();
    this.rhythmSource = null;
    this.rhythmAnalyser = null;
    this.rhythmBins = null;
  }
}
