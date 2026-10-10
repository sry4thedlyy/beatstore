"use client";

import Image from "next/image";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./icons";

interface Track {
  id: string;
  title: string;
  thumbnailId: string;
  previewId: string;
}
interface PlayerContext {
  currentId?: string;
  playing: boolean;
  toggle(track: Track): void;
}
const Context = createContext<PlayerContext | null>(null);

export function timeLabel(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function AudioPlayerProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(null);
  const activeId = useRef<string | undefined>(undefined);
  const [track, setTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");

  function toggle(next: Track) {
    const element = audio.current;
    if (!element) return;
    setError("");
    if (activeId.current === next.id && !element.paused) {
      element.pause();
      return;
    }
    if (activeId.current !== next.id) {
      activeId.current = next.id;
      element.src = `/media/${next.previewId}`;
      setTrack(next);
      setPosition(0);
      setDuration(0);
    }
    void element.play().catch(() => {
      if (activeId.current === next.id) {
        setPlaying(false);
        setError("Не удалось воспроизвести превью. Попробуйте ещё раз.");
      }
    });
  }

  function close() {
    audio.current?.pause();
    audio.current?.removeAttribute("src");
    audio.current?.load();
    activeId.current = undefined;
    setTrack(null);
    setPlaying(false);
    setPosition(0);
    setDuration(0);
    setError("");
  }

  return (
    <Context.Provider value={{ currentId: track?.id, playing, toggle }}>
      {children}
      <audio
        ref={audio}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onError={() => {
          if (activeId.current) {
            setPlaying(false);
            setError("Превью временно недоступно.");
          }
        }}
      />
      {track && (
        <aside className="player" aria-label="Аудиоплеер">
          <div className="player-track">
            <Image
              src={`/media/${track.thumbnailId}`}
              alt=""
              width={48}
              height={48}
              unoptimized
            />
            <div>
              <strong>{track.title}</strong>
              <span>Аудиопревью</span>
            </div>
          </div>
          <button
            className="player-toggle"
            type="button"
            onClick={() => toggle(track)}
            aria-label={playing ? "Приостановить превью" : "Продолжить превью"}
          >
            <Icon name={playing ? "pause" : "play"} />
          </button>
          <div className="player-progress">
            <span>{timeLabel(position)}</span>
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.1}
              value={Math.min(position, duration || 1)}
              aria-label="Позиция воспроизведения"
              onChange={(event) => {
                const value = Number(event.target.value);
                if (audio.current) audio.current.currentTime = value;
                setPosition(value);
              }}
            />
            <span>{timeLabel(duration)}</span>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={close}
            aria-label="Закрыть плеер"
          >
            <Icon name="close" />
          </button>
          {error && (
            <p className="player-error" role="alert">
              {error}
            </p>
          )}
        </aside>
      )}
    </Context.Provider>
  );
}

export function PreviewButton({
  track,
  large = false,
}: {
  track: Track;
  large?: boolean;
}) {
  const player = useContext(Context);
  if (!player) throw new Error("PreviewButton requires AudioPlayerProvider");
  const active = player.currentId === track.id && player.playing;
  return (
    <button
      className={large ? "preview-button large" : "preview-button"}
      type="button"
      onClick={() => player.toggle(track)}
      aria-label={`${active ? "Приостановить" : "Слушать"} ${track.title}`}
      aria-pressed={active}
    >
      <Icon name={active ? "pause" : "play"} />
      {large && <span>{active ? "Пауза" : "Слушать превью"}</span>}
    </button>
  );
}
