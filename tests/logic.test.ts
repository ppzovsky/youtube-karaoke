import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTEMPTS_KEY, buildLeaderboard, clearAttempts, normalizePlayerName, readAttempts, writeAttempts } from "../lib/storage.ts";
import { createAccumulator, recordVoicedFrame, scorePerformance } from "../lib/scoring.ts";
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
