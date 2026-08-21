export type ScoreBreakdown = {
  presence: number;
  control: number;
  consistency: number;
  expressiveness: number;
};

export type VideoSummary = {
  id: string;
  title: string;
  channel: string;
  thumbnail: string;
  duration: string;
  durationSeconds: number;
};

export type Attempt = {
  id: string;
  playerName: string;
  normalizedPlayerName: string;
  video: Pick<VideoSummary, "id" | "title" | "channel">;
  score: number;
  breakdown: ScoreBreakdown;
  voicedSeconds: number;
  completedAt: string;
};

export type PerformanceResult = {
  valid: boolean;
  score: number;
  breakdown: ScoreBreakdown;
  voicedSeconds: number;
};
