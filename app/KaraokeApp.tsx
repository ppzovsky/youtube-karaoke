"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ATTEMPTS_KEY,
  LAST_NAME_KEY,
  addAttempt,
  buildLeaderboard,
  clearAttempts,
  normalizePlayerName,
  readAttempts,
} from "../lib/storage";
import type { Attempt, PerformanceResult, VideoSummary } from "../lib/types";
import { VoiceSession, type LiveMetrics } from "../lib/voice-session";

type View = "home" | "results" | "calibrating" | "ready" | "singing" | "score" | "leaderboard";
type PlayerInstance = { playVideo: () => void; destroy: () => void; stopVideo: () => void };
type YouTubeApi = {
  Player: new (
    elementId: string,
    options: {
      videoId: string;
      playerVars: Record<string, string | number>;
      events: {
        onReady: (event: { target: PlayerInstance }) => void;
        onStateChange: (event: { data: number }) => void;
        onError: () => void;
      };
    },
  ) => PlayerInstance;
  PlayerState: { ENDED: number };
};

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youtubeApiPromise: Promise<YouTubeApi> | null = null;

function loadYouTubeApi(): Promise<YouTubeApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("YouTube indisponível")), 12000);
    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timeout);
      if (window.YT) resolve(window.YT);
      else reject(new Error("YouTube indisponível"));
    };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => reject(new Error("YouTube indisponível"));
      document.head.appendChild(script);
    }
  });
  return youtubeApiPromise;
}

function cleanTitle(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function metricLabel(value: number): string {
  if (value >= 85) return "INCRÍVEL";
  if (value >= 65) return "MANDOU BEM";
  if (value >= 40) return "AQUECENDO";
  return "VAI COM TUDO";
}

export default function KaraokeApp() {
  const [view, setView] = useState<View>("home");
  const [singer, setSinger] = useState("");
  const [song, setSong] = useState("");
  const [videos, setVideos] = useState<VideoSummary[]>([]);
  const [selected, setSelected] = useState<VideoSummary | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [result, setResult] = useState<PerformanceResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState("");
  const [calibration, setCalibration] = useState(0);
  const [metrics, setMetrics] = useState<LiveMetrics>({ presence: 0, control: 0, energy: 0, voicedSeconds: 0 });
  const [confirmClear, setConfirmClear] = useState(false);
  const voiceRef = useRef<VoiceSession | null>(null);
  const playerRef = useRef<PlayerInstance | null>(null);
  const finishingRef = useRef(false);
  const finishRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const stored = readAttempts(window.localStorage);
    setAttempts(stored.attempts);
    setSinger(window.localStorage.getItem(LAST_NAME_KEY) ?? "");
    if (stored.recovered) {
      setMessage("O histórico anterior estava danificado. Guardamos uma cópia de recuperação e iniciamos um placar vazio.");
    }
  }, []);

  useEffect(() => () => voiceRef.current?.cancel(), []);

  const leaderboard = useMemo(() => buildLeaderboard(attempts), [attempts]);
  const isBusy = view === "calibrating" || view === "ready" || view === "singing";

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = singer.trim().replace(/\s+/g, " ");
    if (!trimmedName) return setMessage("Antes da música, conta pra gente quem vai subir no palco.");
    if (song.trim().length < 2) return setMessage("Digite o nome de uma música ou artista.");
    setMessage("");
    setSearching(true);
    window.localStorage.setItem(LAST_NAME_KEY, trimmedName);
    try {
      const response = await fetch(`/api/youtube/search?q=${encodeURIComponent(song.trim())}`);
      const data = await response.json() as { videos?: VideoSummary[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "A busca falhou.");
      setVideos(data.videos ?? []);
      setView("results");
      if (!data.videos?.length) setMessage("Nenhum karaokê disponível apareceu nessa busca. Tente outro título ou artista.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível buscar agora.");
    } finally {
      setSearching(false);
    }
  };

  const preparePerformance = async (video: VideoSummary) => {
    setMessage("");
    setSelected(video);
    setCalibration(0);
    setView("calibrating");
    const session = new VoiceSession();
    voiceRef.current = session;
    try {
      await session.prepare(setCalibration);
      setView("ready");
    } catch (error) {
      session.cancel();
      voiceRef.current = null;
      const name = error instanceof DOMException ? error.name : "";
      setMessage(
        name === "NotAllowedError"
          ? "O acesso ao microfone foi bloqueado. Libere a permissão do microfone no navegador e tente novamente."
          : error instanceof Error ? error.message : "Não foi possível preparar o microfone.",
      );
      setView("results");
    }
  };

  const startSinging = () => {
    finishingRef.current = false;
    setMetrics({ presence: 0, control: 0, energy: 0, voicedSeconds: 0 });
    setView("singing");
    try {
      voiceRef.current?.start(setMetrics);
    } catch {
      setMessage("O microfone perdeu a conexão. Volte e tente prepará-lo novamente.");
      setView("results");
    }
  };

  const finishPerformance = useCallback(() => {
    if (finishingRef.current || !selected || !voiceRef.current) return;
    finishingRef.current = true;
    playerRef.current?.stopVideo();
    const finalResult = voiceRef.current.finish();
    voiceRef.current = null;
    setResult(finalResult);
    if (finalResult.valid) {
      const attempt: Attempt = {
        id: crypto.randomUUID(),
        playerName: singer.trim().replace(/\s+/g, " "),
        normalizedPlayerName: normalizePlayerName(singer),
        video: { id: selected.id, title: cleanTitle(selected.title), channel: selected.channel },
        score: finalResult.score,
        breakdown: finalResult.breakdown,
        voicedSeconds: finalResult.voicedSeconds,
        completedAt: new Date().toISOString(),
      };
      setAttempts(addAttempt(window.localStorage, attempt));
    }
    setView("score");
  }, [selected, singer]);

  finishRef.current = finishPerformance;

  useEffect(() => {
    if (view !== "singing" || !selected) return;
    let disposed = false;
    loadYouTubeApi()
      .then((api) => {
        if (disposed) return;
        playerRef.current = new api.Player("karaoke-player", {
          videoId: selected.id,
          playerVars: { autoplay: 1, playsinline: 1, rel: 0, origin: window.location.origin },
          events: {
            onReady: ({ target }) => target.playVideo(),
            onStateChange: ({ data }) => {
              if (data === api.PlayerState.ENDED) finishRef.current();
            },
            onError: () => {
              voiceRef.current?.cancel();
              voiceRef.current = null;
              setMessage("Este vídeo ficou indisponível para reprodução. Escolha outro resultado.");
              setView("results");
            },
          },
        });
      })
      .catch(() => {
        voiceRef.current?.cancel();
        voiceRef.current = null;
        setMessage("O player do YouTube não carregou. Verifique a conexão e tente novamente.");
        setView("results");
      });
    return () => {
      disposed = true;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [view, selected]);

  const goHome = () => {
    setMessage("");
    setResult(null);
    setSelected(null);
    setSong("");
    setVideos([]);
    setView("home");
  };

  const clearHistory = () => {
    clearAttempts(window.localStorage);
    setAttempts([]);
    setConfirmClear(false);
  };

  return (
    <main className={`arcade-shell view-${view}`}>
      <header className="topbar">
        <button className="brand" type="button" onClick={goHome} aria-label="Karaoke Arcade — início" disabled={isBusy}>
          <span className="brand-mark" aria-hidden="true">♪</span>
          <span>KARAOKE <b>ARCADE</b></span>
        </button>
        <button className="leaderboard-button" type="button" onClick={() => { setMessage(""); setView("leaderboard"); }} disabled={isBusy || view === "leaderboard"}>
          <span aria-hidden="true">♛</span> LEADERBOARD
          {leaderboard.length > 0 && <i>{leaderboard.length}</i>}
        </button>
      </header>

      {(view === "home" || view === "results") && (
        <>
          <section className={`hero ${view === "results" ? "hero-results" : ""}`} id="top">
            <div className="hero-copy">
              <p className="eyebrow"><span /> LUZES ACESAS. MICROFONE PRONTO.</p>
              <h1>SUA VOZ.<br /><em>SEU PALCO.</em></h1>
              <p className="intro">Escolha seu hit, solte a voz e conquiste o topo do placar. Não precisa instalar nada — só coragem para cantar.</p>
              <div className="privacy-note"><span aria-hidden="true">◆</span><p><strong>SUA VOZ FICA AQUI.</strong><br />O áudio é analisado neste aparelho e nunca é gravado ou enviado.</p></div>
            </div>

            <form className="start-card" onSubmit={search}>
              <div className="card-heading"><span className="step-number">01</span><div><p>PREPARE-SE</p><h2>QUEM VAI CANTAR?</h2></div></div>
              <label htmlFor="singer">SEU NOME</label>
              <div className="input-wrap name-input"><span aria-hidden="true">●</span><input id="singer" value={singer} onChange={(event) => setSinger(event.target.value)} maxLength={40} autoComplete="nickname" placeholder="Digite seu nome de estrela" /></div>
              <label htmlFor="song">QUAL MÚSICA?</label>
              <div className="search-row">
                <div className="input-wrap"><span aria-hidden="true">⌕</span><input id="song" value={song} onChange={(event) => setSong(event.target.value)} maxLength={80} placeholder="Artista ou nome da música" /></div>
                <button className="search-button" type="submit" disabled={searching}>{searching ? "BUSCANDO…" : <>BUSCAR <span aria-hidden="true">→</span></>}</button>
              </div>
              <p className="helper"><span aria-hidden="true">▣</span> A gente adiciona “karaoke” à busca automaticamente.</p>
              {message && <p className="message" role="alert">{message}</p>}
            </form>
          </section>

          {view === "home" && (
            <section className="features" aria-label="Como funciona">
              <article><span>01</span><div className="feature-icon">⌕</div><h3>ESCOLHA O HIT</h3><p>Catálogo do YouTube, buscando sempre por karaokê.</p></article>
              <article><span>02</span><div className="feature-icon">♬</div><h3>SOLTE A VOZ</h3><p>Seu microfone acompanha energia, controle e presença.</p></article>
              <article><span>03</span><div className="feature-icon">★</div><h3>DOMINE O PLACAR</h3><p>Sua melhor nota fica salva neste aparelho.</p></article>
            </section>
          )}

          {view === "results" && (
            <section className="results-section" aria-live="polite">
              <div className="section-title"><div><p>RESULTADOS PARA</p><h2>“{song}”</h2></div><span>{videos.length} VÍDEOS DISPONÍVEIS</span></div>
              <div className="video-grid">
                {videos.map((video, index) => (
                  <article className="video-card" key={video.id}>
                    <button type="button" onClick={() => preparePerformance(video)} aria-label={`Cantar ${cleanTitle(video.title)}`}>
                      <span className="video-number">{String(index + 1).padStart(2, "0")}</span>
                      <span className="thumb-wrap"><img src={video.thumbnail} alt="" /><i>{video.duration}</i><b aria-hidden="true">▶</b></span>
                      <span className="video-info"><strong>{cleanTitle(video.title)}</strong><small>{video.channel}</small><em>CANTAR AGORA <span>→</span></em></span>
                    </button>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {view === "calibrating" && selected && (
        <section className="center-stage calibration-stage">
          <p className="eyebrow"><span /> AJUSTANDO O SOM</p>
          <div className="calibration-orb"><i style={{ transform: `scale(${0.75 + calibration * 0.25})` }}>●</i><span>{Math.round(calibration * 100)}%</span></div>
          <h1>FIQUE EM <em>SILÊNCIO</em></h1>
          <p>Estamos ouvindo o ambiente por três segundos para separar melhor sua voz do ruído.</p>
          <div className="progress-track"><i style={{ width: `${calibration * 100}%` }} /></div>
        </section>
      )}

      {view === "ready" && selected && (
        <section className="center-stage ready-stage">
          <p className="eyebrow"><span /> MICROFONE PRONTO</p>
          <span className="ready-check" aria-hidden="true">✓</span>
          <h1>HORA DO <em>SHOW!</em></h1>
          <div className="selected-song"><img src={selected.thumbnail} alt="" /><div><small>{singer}, VOCÊ VAI CANTAR</small><strong>{cleanTitle(selected.title)}</strong><span>{selected.channel} · {selected.duration}</span></div></div>
          <button className="primary-action" type="button" onClick={startSinging}>COMEÇAR APRESENTAÇÃO <span aria-hidden="true">▶</span></button>
          <button className="text-button" type="button" onClick={() => { voiceRef.current?.cancel(); voiceRef.current = null; setView("results"); }}>ESCOLHER OUTRA MÚSICA</button>
        </section>
      )}

      {view === "singing" && selected && (
        <section className="performance-stage">
          <div className="performance-heading"><div><p>AGORA NO PALCO</p><h2>{singer}</h2></div><div className="singing-live"><i /> AO VIVO</div></div>
          <div className="performance-layout">
            <div className="player-frame"><div id="karaoke-player" /><div className="player-label"><span>{cleanTitle(selected.title)}</span><small>{selected.channel}</small></div></div>
            <aside className="meters-panel">
              <div className="meter-title"><span aria-hidden="true">▥</span><div><small>ANÁLISE LOCAL</small><strong>SUA PERFORMANCE</strong></div></div>
              {([ ["PRESENÇA", metrics.presence, "cyan"], ["CONTROLE", metrics.control, "pink"], ["ENERGIA", metrics.energy, "yellow"] ] as const).map(([label, value, color]) => (
                <div className={`meter ${color}`} key={label}><div><span>{label}</span><strong>{metricLabel(value)}</strong></div><div className="meter-track"><i style={{ width: `${value}%` }} /></div><small>{value}%</small></div>
              ))}
              <div className="valid-time"><span>TEMPO DE VOZ VÁLIDA</span><strong>{metrics.voicedSeconds.toFixed(1)}s <small>/ mínimo 15s</small></strong><div className="meter-track"><i style={{ width: `${Math.min(100, metrics.voicedSeconds / 15 * 100)}%` }} /></div></div>
              <p><span aria-hidden="true">◆</span> Esta é uma avaliação divertida de presença, controle e energia — não compara sua voz com a melodia original.</p>
              <button className="end-button" type="button" onClick={finishPerformance}>ENCERRAR APRESENTAÇÃO</button>
            </aside>
          </div>
        </section>
      )}

      {view === "score" && result && selected && (
        <section className="center-stage score-stage">
          {result.valid ? (
            <>
              <div className="confetti" aria-hidden="true">✦　▪　★　◆　✦　▪　★</div>
              <p className="eyebrow"><span /> NOTA SALVA NO PLACAR</p>
              <p className="score-kicker">{singer}, VOCÊ ARRASOU!</p>
              <div className="score-number"><strong>{result.score}</strong><span>/100</span></div>
              <h1>{result.score >= 80 ? "LENDA DO" : result.score >= 60 ? "SHOW DE" : "PALCO É"} <em>{result.score >= 80 ? "PALCO!" : result.score >= 60 ? "VOZ!" : "SEU!"}</em></h1>
              <div className="breakdown-grid">
                <article><span>PRESENÇA</span><strong>{result.breakdown.presence}<small>/25</small></strong></article>
                <article><span>CONTROLE</span><strong>{result.breakdown.control}<small>/35</small></strong></article>
                <article><span>CONSISTÊNCIA</span><strong>{result.breakdown.consistency}<small>/20</small></strong></article>
                <article><span>EXPRESSIVIDADE</span><strong>{result.breakdown.expressiveness}<small>/20</small></strong></article>
              </div>
            </>
          ) : (
            <>
              <p className="eyebrow"><span /> APRESENTAÇÃO ENCERRADA</p>
              <span className="invalid-icon" aria-hidden="true">♪</span>
              <h1>QUASE <em>LÁ!</em></h1>
              <p className="invalid-copy">Detectamos {result.voicedSeconds.toFixed(1)} segundos de voz. Cante por pelo menos 15 segundos para entrar no placar.</p>
            </>
          )}
          <div className="score-actions"><button className="primary-action" type="button" onClick={goHome}>CANTAR OUTRA <span>→</span></button><button className="secondary-action" type="button" onClick={() => setView("leaderboard")}>VER LEADERBOARD</button></div>
        </section>
      )}

      {view === "leaderboard" && (
        <section className="leaderboard-stage">
          <div className="leaderboard-heading"><div><p className="eyebrow"><span /> HALL DA FAMA LOCAL</p><h1>LEADER<em>BOARD</em></h1><p>Somente a melhor nota de cada estrela aparece no ranking.</p></div><button className="secondary-action" type="button" onClick={goHome}>← VOLTAR AO PALCO</button></div>
          {leaderboard.length === 0 ? (
            <div className="empty-board"><span aria-hidden="true">♛</span><h2>O PALCO ESTÁ VAZIO</h2><p>A primeira apresentação válida inaugura o hall da fama.</p><button className="primary-action" type="button" onClick={goHome}>SER O PRIMEIRO</button></div>
          ) : (
            <>
              <div className="podium">
                {[leaderboard[1], leaderboard[0], leaderboard[2]].map((attempt, visualIndex) => attempt && (
                  <article className={`podium-card place-${visualIndex === 1 ? 1 : visualIndex === 0 ? 2 : 3}`} key={attempt.id}><span className="crown">{visualIndex === 1 ? "♛" : "★"}</span><small>{visualIndex === 1 ? "1º" : visualIndex === 0 ? "2º" : "3º"} LUGAR</small><h2>{attempt.playerName}</h2><strong>{attempt.score}</strong><p>{attempt.video.title}</p></article>
                ))}
              </div>
              <div className="ranking-list">
                {leaderboard.map((attempt, index) => (
                  <article key={attempt.id}><span className="rank">#{String(index + 1).padStart(2, "0")}</span><div className="avatar">{attempt.playerName.slice(0, 1).toUpperCase()}</div><div><strong>{attempt.playerName}</strong><small>{attempt.video.title} · {new Date(attempt.completedAt).toLocaleDateString("pt-BR")}</small></div><b>{attempt.score}<small> PTS</small></b></article>
                ))}
              </div>
              <div className="history-footer"><span>{attempts.length} {attempts.length === 1 ? "APRESENTAÇÃO SALVA" : "APRESENTAÇÕES SALVAS"} NESTE APARELHO</span><button className="danger-button" type="button" onClick={() => setConfirmClear(true)}>LIMPAR HISTÓRICO</button></div>
            </>
          )}
        </section>
      )}

      {confirmClear && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setConfirmClear(false)}>
          <div className="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="clear-title" onMouseDown={(event) => event.stopPropagation()}>
            <span aria-hidden="true">!</span><h2 id="clear-title">LIMPAR TODO O HISTÓRICO?</h2><p>Essa ação apaga permanentemente todas as notas salvas neste aparelho.</p><div><button className="danger-button" type="button" onClick={clearHistory}>SIM, LIMPAR</button><button className="secondary-action" type="button" onClick={() => setConfirmClear(false)} autoFocus>CANCELAR</button></div>
          </div>
        </div>
      )}

      <footer><span>KARAOKE ARCADE</span><p>Feito para cantar alto e se divertir.</p><small>Áudio processado localmente · Dados salvos neste aparelho</small></footer>
      <span className="sr-only" aria-live="polite">{ATTEMPTS_KEY && `${attempts.length} apresentações salvas`}</span>
    </main>
  );
}
