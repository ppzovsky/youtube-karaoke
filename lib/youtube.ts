const KARAOKE_WORD = /(^|[^\p{L}])karaok[eê](?=$|[^\p{L}])/iu;

export function normalizeSearchQuery(input: string): string {
  const compact = input.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!compact) return "";
  return KARAOKE_WORD.test(compact) ? compact : `${compact} karaoke`;
}

export function parseIsoDuration(value: string): number {
  const match = value.match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  return (
    Number(match[1] ?? 0) * 86400 +
    Number(match[2] ?? 0) * 3600 +
    Number(match[3] ?? 0) * 60 +
    Number(match[4] ?? 0)
  );
}

export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}
