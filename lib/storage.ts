import type { Attempt } from "./types";

export const ATTEMPTS_KEY = "youtube-karaoke:attempts:v1";
export const LAST_NAME_KEY = "youtube-karaoke:last-name:v1";

function isAttempt(value: unknown): value is Attempt {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.playerName === "string" &&
    typeof item.normalizedPlayerName === "string" &&
    typeof item.score === "number" &&
    typeof item.voicedSeconds === "number" &&
    typeof item.completedAt === "string" &&
    !!item.video &&
    typeof item.video === "object" &&
    !!item.breakdown &&
    typeof item.breakdown === "object"
  );
}

export function normalizePlayerName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

export function readAttempts(storage: Storage): { attempts: Attempt[]; recovered: boolean } {
  const raw = storage.getItem(ATTEMPTS_KEY);
  if (!raw) return { attempts: [], recovered: false };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isAttempt)) throw new Error("invalid schema");
    return { attempts: parsed, recovered: false };
  } catch {
    storage.setItem(`youtube-karaoke:attempts:recovery:${Date.now()}`, raw);
    storage.removeItem(ATTEMPTS_KEY);
    return { attempts: [], recovered: true };
  }
}

export function writeAttempts(storage: Storage, attempts: Attempt[]): void {
  storage.setItem(ATTEMPTS_KEY, JSON.stringify(attempts));
}

export function addAttempt(storage: Storage, attempt: Attempt): Attempt[] {
  const current = readAttempts(storage).attempts;
  const next = [...current, attempt];
  writeAttempts(storage, next);
  return next;
}

export function clearAttempts(storage: Storage): void {
  storage.removeItem(ATTEMPTS_KEY);
}

export function buildLeaderboard(attempts: Attempt[]): Attempt[] {
  const bestByPlayer = new Map<string, Attempt>();
  for (const attempt of attempts) {
    const current = bestByPlayer.get(attempt.normalizedPlayerName);
    if (
      !current ||
      attempt.score > current.score ||
      (attempt.score === current.score && attempt.completedAt < current.completedAt)
    ) {
      bestByPlayer.set(attempt.normalizedPlayerName, attempt);
    }
  }

  return [...bestByPlayer.values()].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.completedAt !== b.completedAt) return a.completedAt.localeCompare(b.completedAt);
    return a.playerName.localeCompare(b.playerName, "pt-BR", { sensitivity: "base" });
  });
}
