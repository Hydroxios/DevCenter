import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Music2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from "lucide-react";

import { cn } from "@/lib/utils";
import { api, isTauri } from "@/services/tauri";
import type { NowPlaying, SpotifyControl } from "@/types";

const POLL_MS = 1000;
const IDLE_POLL_MS = 4000;

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Lecture en cours, interrogée chaque seconde ; la position avance localement entre deux mesures. */
function useSpotify() {
  const [track, setTrack] = useState<NowPlaying | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [art, setArt] = useState<string | null>(null);
  const measured = useRef(0);
  const artKey = useRef<string | null>(null);
  const trackRef = useRef(track);
  trackRef.current = track;

  const refresh = useCallback(async () => {
    if (!isTauri()) return setTrack(null);
    try {
      const t = await api.spotify.nowPlaying();
      measured.current = performance.now();
      setTrack(t);
      setError(null);
      if (t && t.trackKey !== artKey.current) {
        artKey.current = t.trackKey;
        const bytes = await api.spotify.artwork().catch(() => null);
        setArt((old) => {
          if (old) URL.revokeObjectURL(old);
          return bytes && bytes.byteLength > 0 ? URL.createObjectURL(new Blob([bytes])) : null;
        });
      }
      if (!t) artKey.current = null;
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    let timer = 0;
    let alive = true;
    const loop = async () => {
      if (document.visibilityState === "visible") await refresh();
      if (alive) timer = window.setTimeout(loop, trackRef.current ? POLL_MS : IDLE_POLL_MS);
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [refresh]);

  const artRef = useRef(art);
  artRef.current = art;
  useEffect(() => () => {
    if (artRef.current) URL.revokeObjectURL(artRef.current);
  }, []);

  return { track, art, error, refresh, measured };
}

/** Position affichée : extrapolée pendant la lecture (rafraîchie 4 fois par seconde). */
function useLivePosition(track: NowPlaying | null | undefined, measured: React.RefObject<number>) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!track?.playing) return;
    const id = window.setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [track?.playing]);
  if (!track) return 0;
  const extra = track.playing ? performance.now() - measured.current : 0;
  return Math.min(track.durationMs, track.positionMs + extra);
}

function IconButton({
  label,
  onClick,
  active,
  big,
  small,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  big?: boolean;
  small?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40",
        big
          ? cn(small ? "size-8" : "size-9", "bg-foreground text-background hover:scale-105 hover:bg-primary")
          : cn(small ? "size-7" : "size-8", "text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"),
        active && !big && "text-primary hover:text-primary",
      )}
    >
      {children}
    </button>
  );
}

export function SpotifyWidget({ width, height }: { width: number; height: number }) {
  const { track, art, error, refresh, measured } = useSpotify();
  const position = useLivePosition(track, measured);
  const [seeking, setSeeking] = useState<number | null>(null);
  // Optimiste : le bouton lecture/pause répond tout de suite, la mesure suivante confirme.
  const [pending, setPending] = useState<boolean | null>(null);

  const send = async (action: SpotifyControl) => {
    if (action === "toggle" && track) setPending(!track.playing);
    try {
      await api.spotify.control(action);
    } catch {
      /* l'état réel revient avec la mesure suivante */
    }
    window.setTimeout(() => {
      refresh().finally(() => setPending(null));
    }, 250);
  };

  if (track === undefined) {
    return <div className="flex h-full items-center justify-center meta">Recherche de Spotify…</div>;
  }

  if (!track) {
    return (
      <div className={cn("flex h-full items-center justify-center gap-3 p-4", height < 200 ? "flex-row text-left" : "flex-col text-center")}>
        <Music2 className="size-7 shrink-0 stroke-[1.25] text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm">Spotify n'est pas ouvert</p>
          <p className="meta mt-0.5 line-clamp-2 text-[11px]">{error ?? "Lancez l'application de bureau pour la piloter ici."}</p>
        </div>
        {isTauri() && (
          <button
            type="button"
            onClick={() => openUrl("spotify:").catch(() => {})}
            className="shrink-0 rounded-full border px-3 py-1 text-xs whitespace-nowrap transition-colors hover:border-primary/50 hover:text-primary"
          >
            Ouvrir Spotify
          </button>
        )}
      </div>
    );
  }

  const playing = pending ?? track.playing;
  const shown = seeking ?? position;
  const pct = track.durationMs > 0 ? (shown / track.durationMs) * 100 : 0;
  // Grand format : pochette au-dessus ; sinon pochette à gauche.
  const tall = height >= width * 0.9 && height > 300;
  // Réduit : boutons plus petits, sans aléatoire / répétition ni temps.
  const compact = height < 130;

  const seekFrom = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * track.durationMs;
  };

  const progress = (
    <div className="flex w-full items-center gap-2">
      {!compact && <span className="meta w-8 shrink-0 text-right text-[10px]">{fmt(shown)}</span>}
      <div
        role="slider"
        aria-label="Position"
        aria-valuemin={0}
        aria-valuemax={track.durationMs}
        aria-valuenow={Math.round(shown)}
        className={cn("group relative h-3 min-w-0 flex-1", track.canSeek ? "cursor-pointer" : "cursor-default")}
        onPointerDown={(e) => {
          if (!track.canSeek) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setSeeking(seekFrom(e));
        }}
        onPointerMove={(e) => seeking !== null && setSeeking(seekFrom(e))}
        onPointerUp={(e) => {
          if (seeking === null) return;
          const target = seekFrom(e);
          setSeeking(null);
          api.spotify.seek(target).catch(() => {}).finally(() => window.setTimeout(refresh, 250));
        }}
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-foreground/15">
          <div className="h-full rounded-full bg-foreground group-hover:bg-primary" style={{ width: `${pct}%` }} />
        </div>
        {track.canSeek && (
          <div
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground opacity-0 shadow group-hover:opacity-100"
            style={{ left: `${pct}%` }}
          />
        )}
      </div>
      {!compact && <span className="meta w-8 shrink-0 text-[10px]">{fmt(track.durationMs)}</span>}
    </div>
  );

  const RepeatIcon = track.repeat === "track" ? Repeat1 : Repeat;
  const controls = (
    <div className="flex items-center justify-center gap-1">
      {track.shuffle !== null && !compact && (
        <IconButton label="Lecture aléatoire" active={track.shuffle} onClick={() => send("shuffle")}>
          <Shuffle className="size-4" />
        </IconButton>
      )}
      <IconButton label="Précédent" small={compact} onClick={() => send("previous")}>
        <SkipBack className="size-4 fill-current" />
      </IconButton>
      <IconButton label={playing ? "Pause" : "Lecture"} big small={compact} onClick={() => send("toggle")}>
        {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
      </IconButton>
      <IconButton label="Suivant" small={compact} onClick={() => send("next")}>
        <SkipForward className="size-4 fill-current" />
      </IconButton>
      {track.repeat !== null && !compact && (
        <IconButton label="Répéter" active={track.repeat !== "none"} onClick={() => send("repeat")}>
          <RepeatIcon className="size-4" />
        </IconButton>
      )}
    </div>
  );

  const cover = (cls: string) =>
    art ? (
      <img src={art} alt="" draggable={false} className={cn("rounded-md object-cover shadow-lg", cls)} />
    ) : (
      <div className={cn("flex items-center justify-center rounded-md bg-foreground/[0.06]", cls)}>
        <Music2 className="size-1/3 stroke-[1.25] text-muted-foreground" aria-hidden />
      </div>
    );

  const meta = (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium" title={track.title}>
        {track.title || "—"}
      </p>
      <p className="truncate text-xs text-muted-foreground" title={track.artist}>
        {track.artist}
        {track.album && !compact && <span className="opacity-60"> · {track.album}</span>}
      </p>
    </div>
  );

  return (
    <div className="relative h-full overflow-hidden">
      {/* Fond : la pochette floutée teinte le widget aux couleurs du morceau. */}
      {art && (
        <img
          src={art}
          alt=""
          aria-hidden
          draggable={false}
          className="pointer-events-none absolute inset-0 size-full scale-125 object-cover opacity-25 blur-2xl saturate-150"
        />
      )}
      {tall ? (
        <div className="relative flex h-full flex-col gap-3 p-4">
          <div className="flex min-h-0 flex-1 items-center justify-center">{cover("aspect-square h-full max-w-full")}</div>
          {meta}
          {progress}
          {controls}
        </div>
      ) : (
        <div className={cn("relative flex h-full items-center gap-3", compact ? "p-2.5" : "p-3")}>
          {cover("aspect-square h-full max-h-40 shrink-0")}
          <div className={cn("flex min-w-0 flex-1 flex-col justify-center", compact ? "gap-1" : "gap-1.5")}>
            {meta}
            {progress}
            {controls}
          </div>
        </div>
      )}
    </div>
  );
}
