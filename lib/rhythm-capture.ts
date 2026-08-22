export type RhythmCaptureResult =
  | { status: "active"; reused: boolean }
  | { status: "no-audio" }
  | { status: "cancelled" }
  | { status: "unsupported" };

type CaptureRequester = () => Promise<MediaStream>;
type CaptureListener = (active: boolean) => void;

function requestDisplayAudio(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return Promise.reject(new Error("Captura de áudio indisponível."));
  }
  return navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
}

/** Mantém uma única captura da aba durante toda a sessão de festa. */
export class RhythmCapture {
  private stream: MediaStream | null = null;
  private readonly listeners = new Set<CaptureListener>();
  private readonly requestCapture: CaptureRequester;
  private readonly isSupported: () => boolean;

  constructor(
    requestCapture: CaptureRequester = requestDisplayAudio,
    isSupported = () => typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia),
  ) {
    this.requestCapture = requestCapture;
    this.isSupported = isSupported;
  }

  get active(): boolean {
    return Boolean(this.stream?.getAudioTracks().some((track) => track.readyState === "live"));
  }

  get activeStream(): MediaStream | null {
    return this.active ? this.stream : null;
  }

  subscribe(listener: CaptureListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async acquire(): Promise<RhythmCaptureResult> {
    if (this.active) return { status: "active", reused: true };
    this.release(false);

    if (!this.isSupported()) {
      return { status: "unsupported" };
    }

    try {
      const stream = await this.requestCapture();
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((track) => track.stop());
        return { status: "no-audio" };
      }
      this.stream = stream;
      stream.getTracks().forEach((track) => track.addEventListener("ended", this.handleTrackEnded));
      this.notify();
      return { status: "active", reused: false };
    } catch {
      return { status: "cancelled" };
    }
  }

  stop(): void {
    this.release(true);
  }

  private handleTrackEnded = (): void => {
    this.release(true);
  };

  private release(notify: boolean): void {
    const stream = this.stream;
    if (!stream) return;
    this.stream = null;
    stream.getTracks().forEach((track) => {
      track.removeEventListener("ended", this.handleTrackEnded);
      if (track.readyState === "live") track.stop();
    });
    if (notify) this.notify();
  }

  private notify(): void {
    const active = this.active;
    this.listeners.forEach((listener) => listener(active));
  }
}
