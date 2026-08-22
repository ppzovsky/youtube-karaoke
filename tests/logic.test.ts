import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTEMPTS_KEY, buildLeaderboard, clearAttempts, normalizePlayerName, readAttempts, writeAttempts } from "../lib/storage.ts";
import { createAccumulator, recordVoicedFrame, scorePerformance } from "../lib/scoring.ts";
import { RhythmCapture } from "../lib/rhythm-capture.ts";
import { normalizeSearchQuery, parseIsoDuration } from "../lib/youtube.ts";
import type { Attempt } from "../lib/types.ts";

test("acrescenta karaoke uma única vez", () => {
  assert.equal(normalizeSearchQuery("  Evidências   Chitãozinho  "), "Evidências Chitãozinho karaoke");
  assert.equal(normalizeSearchQuery("Evidências KARAOKE"), "Evidências KARAOKE");
  assert.equal(normalizeSearchQuery("karaokê infantil"), "karaokê infantil");
});

test("converte duração ISO do YouTube", () => {
  assert.equal(parseIsoDuration("PT4M12S"), 252);
  assert.equal(parseIsoDuration("PT1H2M3S"), 3723);
  assert.equal(parseIsoDuration("inválido"), 0);
});

test("normaliza nomes ignorando caixa, acentos e espaços", () => {
  assert.equal(normalizePlayerName("  João   PEDRO "), "joao pedro");
});

function attempt(overrides: Partial<Attempt>): Attempt {
  return {
    id: "1",
    playerName: "João",
    normalizedPlayerName: "joao",
    video: { id: "v", title: "Música", channel: "Canal" },
    score: 70,
    breakdown: { presence: 20, control: 25, consistency: 12, expressiveness: 13 },
    voicedSeconds: 50,
    completedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("leaderboard mantém a melhor nota e desempata pela mais antiga", () => {
  const board = buildLeaderboard([
    attempt({ id: "1", score: 70 }),
    attempt({ id: "2", score: 80, completedAt: "2026-02-01T00:00:00.000Z" }),
    attempt({ id: "3", playerName: "Maria", normalizedPlayerName: "maria", score: 80, completedAt: "2026-01-15T00:00:00.000Z" }),
  ]);
  assert.deepEqual(board.map((item) => item.id), ["3", "2"]);
});

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("histórico persiste em JSON, preserva conteúdo inválido e pode ser limpo", () => {
  const storage = new MemoryStorage();
  const saved = [attempt({ id: "persistida" })];
  writeAttempts(storage, saved);
  assert.deepEqual(readAttempts(storage).attempts, saved);
  storage.setItem(ATTEMPTS_KEY, "{json quebrado");
  const recovered = readAttempts(storage);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.attempts.length, 0);
  assert.ok([...Array(storage.length).keys()].some((index) => storage.key(index)?.includes("recovery")));
  writeAttempts(storage, saved);
  clearAttempts(storage);
  assert.equal(storage.getItem(ATTEMPTS_KEY), null);
});

test("pontuação é determinística, limitada e exige 15 segundos válidos", () => {
  const short = createAccumulator();
  const valid = createAccumulator();
  for (let index = 0; index < 400; index += 1) {
    const frame = {
      frequency: 180 + (index % 30),
      confidence: 0.88,
      rms: 0.12 + (index % 8) * 0.004,
      seconds: 0.05,
      clipped: false,
    };
    if (index < 200) recordVoicedFrame(short, frame);
    recordVoicedFrame(valid, frame);
  }
  const shortScore = scorePerformance(short);
  const first = scorePerformance(valid);
  const second = scorePerformance(valid);
  assert.equal(shortScore.valid, false);
  assert.equal(first.valid, true);
  assert.deepEqual(first, second);
  assert.ok(first.score >= 0 && first.score <= 100);
});

function recordMelody(accumulator: ReturnType<typeof createAccumulator>, offset = 0): void {
  for (let index = 0; index < 400; index += 1) {
    recordVoicedFrame(accumulator, {
      frequency: Math.floor(index / 10) % 2 === 0 ? 180 : 210,
      confidence: 0.9,
      rms: 0.12,
      seconds: 0.05,
      clipped: false,
      at: offset + index * 0.05,
    });
  }
}

test("grito constante não recebe nota alta só pelo volume", () => {
  const shout = createAccumulator();
  for (let index = 0; index < 400; index += 1) {
    recordVoicedFrame(shout, {
      frequency: 180,
      confidence: 0.92,
      rms: 0.42,
      seconds: 0.05,
      clipped: false,
      at: index * 0.05,
    });
  }

  const result = scorePerformance(shout);
  assert.equal(result.valid, true);
  assert.ok(result.score < 70);
  assert.ok(result.breakdown.expressiveness < 8);
});

test("ritmo alinhado com a batida vale mais que ritmo deslocado", () => {
  const aligned = createAccumulator();
  const delayed = createAccumulator();
  const beats = Array.from({ length: 45 }, (_, index) => index * 0.5);
  recordMelody(aligned);
  recordMelody(delayed, 0.125);

  const alignedResult = scorePerformance(aligned, { beatTimes: beats });
  const delayedResult = scorePerformance(delayed, { beatTimes: beats });
  assert.equal(alignedResult.valid, true);
  assert.equal(delayedResult.valid, true);
  assert.ok(alignedResult.breakdown.expressiveness > delayedResult.breakdown.expressiveness);
  assert.ok(alignedResult.score > delayedResult.score);
});

type FakeTrack = {
  readyState: "live" | "ended";
  stopped: number;
  stop: () => void;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  end: () => void;
};

function fakeTrack(): FakeTrack {
  const listeners = new Set<() => void>();
  const track: FakeTrack = {
    readyState: "live",
    stopped: 0,
    stop: () => {
      track.stopped += 1;
      track.readyState = "ended";
    },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    end: () => {
      track.readyState = "ended";
      listeners.forEach((listener) => listener());
    },
  };
  return track;
}

function fakeStream(audioTracks: FakeTrack[], videoTracks: FakeTrack[] = []): MediaStream {
  const tracks = [...audioTracks, ...videoTracks];
  return {
    getAudioTracks: () => audioTracks,
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

test("modo festa reutiliza a captura da aba e encerra todas as faixas", async () => {
  const audio = fakeTrack();
  const video = fakeTrack();
  let requests = 0;
  const capture = new RhythmCapture(async () => {
    requests += 1;
    return fakeStream([audio], [video]);
  }, () => true);

  assert.deepEqual(await capture.acquire(), { status: "active", reused: false });
  assert.deepEqual(await capture.acquire(), { status: "active", reused: true });
  assert.equal(requests, 1);
  assert.equal(capture.active, true);

  capture.stop();
  assert.equal(capture.active, false);
  assert.equal(audio.stopped, 1);
  assert.equal(video.stopped, 1);
});

test("fim do compartilhamento restaura o modo festa para uma nova escolha", async () => {
  const audio = fakeTrack();
  const capture = new RhythmCapture(async () => fakeStream([audio]), () => true);
  const states: boolean[] = [];
  capture.subscribe((active) => states.push(active));

  await capture.acquire();
  audio.end();

  assert.equal(capture.active, false);
  assert.deepEqual(states, [true, false]);
});

test("sem áudio compartilhado, a apresentação pode usar o fallback vocal", async () => {
  const video = fakeTrack();
  const capture = new RhythmCapture(async () => fakeStream([], [video]), () => true);
  assert.deepEqual(await capture.acquire(), { status: "no-audio" });
  assert.equal(video.stopped, 1);
  assert.equal(capture.active, false);
});
