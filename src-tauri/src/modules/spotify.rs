//! Lecteur Spotify : lecture en cours et contrôles via les contrôles multimédias de Windows
//! (SMTC). Aucun compte ni clé d'API : l'application Spotify de bureau publie sa session
//! comme n'importe quel lecteur, DevCenter la retrouve et la pilote.

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Morceau en cours dans Spotify.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    /// Position estimée au moment de la lecture (ms).
    pub position_ms: u64,
    pub duration_ms: u64,
    pub shuffle: Option<bool>,
    /// Répétition : "none" | "track" | "list".
    pub repeat: Option<&'static str>,
    pub can_seek: bool,
    /// Change à chaque morceau : l'interface recharge la pochette seulement dans ce cas.
    pub track_key: String,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Control {
    Toggle,
    Next,
    Previous,
    Shuffle,
    Repeat,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Media::MediaPlaybackAutoRepeatMode as Repeat;
    use windows::Storage::Streams::DataReader;

    fn err(e: windows::core::Error) -> AppError {
        AppError::InvalidInput(format!("Contrôles multimédias Windows : {}", e.message()))
    }

    /// Session publiée par Spotify (identifiant d'application « Spotify.exe » ou paquet Store).
    fn session() -> AppResult<Option<Session>> {
        let manager = Manager::RequestAsync()
            .and_then(|op| op.join())
            .map_err(err)?;
        let sessions = manager.GetSessions().map_err(err)?;
        for s in sessions {
            let id = s
                .SourceAppUserModelId()
                .map(|h| h.to_string())
                .unwrap_or_default();
            if id.to_lowercase().contains("spotify") {
                return Ok(Some(s));
            }
        }
        Ok(None)
    }

    /// Heure courante en ticks de 100 ns depuis 1601 (format `DateTime` de WinRT).
    fn now_ticks() -> i64 {
        let unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as i64 / 100)
            .unwrap_or(0);
        unix + 116_444_736_000_000_000
    }

    pub fn now_playing() -> AppResult<Option<NowPlaying>> {
        let Some(s) = session()? else { return Ok(None) };
        let props = s
            .TryGetMediaPropertiesAsync()
            .and_then(|op| op.join())
            .map_err(err)?;
        let info = s.GetPlaybackInfo().map_err(err)?;
        let timeline = s.GetTimelineProperties().map_err(err)?;

        let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
        let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
        let album = props
            .AlbumTitle()
            .map(|h| h.to_string())
            .unwrap_or_default();
        let playing = info
            .PlaybackStatus()
            .map(|st| st == Status::Playing)
            .unwrap_or(false);

        let ticks = |r: windows::core::Result<windows::Foundation::TimeSpan>| {
            r.map(|t| t.Duration).unwrap_or(0)
        };
        let start = ticks(timeline.StartTime());
        let end = ticks(timeline.EndTime());
        let mut position = ticks(timeline.Position()) - start;
        // Spotify ne rafraîchit la position que de temps en temps : on extrapole depuis la mise à jour.
        if playing && let Ok(updated) = timeline.LastUpdatedTime() {
            position += (now_ticks() - updated.UniversalTime).max(0);
        }
        let duration = (end - start).max(0);
        let position = position.clamp(0, duration.max(0));

        let shuffle = info.IsShuffleActive().ok().and_then(|r| r.Value().ok());
        let repeat = info
            .AutoRepeatMode()
            .ok()
            .and_then(|r| r.Value().ok())
            .map(|m| match m {
                Repeat::Track => "track",
                Repeat::List => "list",
                _ => "none",
            });
        let can_seek = info
            .Controls()
            .and_then(|c| c.IsPlaybackPositionEnabled())
            .unwrap_or(false);

        Ok(Some(NowPlaying {
            track_key: format!("{artist}\u{1f}{title}\u{1f}{album}"),
            title,
            artist,
            album,
            playing,
            position_ms: (position / 10_000) as u64,
            duration_ms: (duration / 10_000) as u64,
            shuffle,
            repeat,
            can_seek,
        }))
    }

    /// Pochette du morceau en cours (octets de l'image), `None` s'il n'y en a pas.
    pub fn artwork() -> AppResult<Option<Vec<u8>>> {
        let Some(s) = session()? else { return Ok(None) };
        let props = s
            .TryGetMediaPropertiesAsync()
            .and_then(|op| op.join())
            .map_err(err)?;
        let Ok(thumb) = props.Thumbnail() else {
            return Ok(None);
        };
        let stream = thumb
            .OpenReadAsync()
            .and_then(|op| op.join())
            .map_err(err)?;
        let size = stream.Size().map_err(err)? as u32;
        if size == 0 {
            return Ok(None);
        }
        let reader =
            DataReader::CreateDataReader(&stream.GetInputStreamAt(0).map_err(err)?).map_err(err)?;
        reader
            .LoadAsync(size)
            .and_then(|op| op.join())
            .map_err(err)?;
        let mut buf = vec![0u8; size as usize];
        reader.ReadBytes(&mut buf).map_err(err)?;
        Ok(Some(buf))
    }

    pub fn control(action: Control) -> AppResult<()> {
        let s = session()?.ok_or(AppError::Unavailable("Spotify n'est pas ouvert"))?;
        let op = match action {
            Control::Toggle => s.TryTogglePlayPauseAsync(),
            Control::Next => s.TrySkipNextAsync(),
            Control::Previous => s.TrySkipPreviousAsync(),
            Control::Shuffle => {
                let info = s.GetPlaybackInfo().map_err(err)?;
                let on = info
                    .IsShuffleActive()
                    .ok()
                    .and_then(|r| r.Value().ok())
                    .unwrap_or(false);
                s.TryChangeShuffleActiveAsync(!on)
            }
            Control::Repeat => {
                let info = s.GetPlaybackInfo().map_err(err)?;
                let mode = info
                    .AutoRepeatMode()
                    .ok()
                    .and_then(|r| r.Value().ok())
                    .unwrap_or(Repeat::None);
                let next = match mode {
                    Repeat::None => Repeat::List,
                    Repeat::List => Repeat::Track,
                    _ => Repeat::None,
                };
                s.TryChangeAutoRepeatModeAsync(next)
            }
        };
        op.and_then(|op| op.join()).map_err(err)?;
        Ok(())
    }

    pub fn seek(position_ms: u64) -> AppResult<()> {
        let s = session()?.ok_or(AppError::Unavailable("Spotify n'est pas ouvert"))?;
        let start = s
            .GetTimelineProperties()
            .and_then(|t| t.StartTime())
            .map(|t| t.Duration)
            .unwrap_or(0);
        s.TryChangePlaybackPositionAsync(start + position_ms as i64 * 10_000)
            .and_then(|op| op.join())
            .map_err(err)?;
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    const NA: AppError = AppError::Unavailable("contrôles Spotify (Windows uniquement)");
    pub fn now_playing() -> AppResult<Option<NowPlaying>> {
        Ok(None)
    }
    pub fn artwork() -> AppResult<Option<Vec<u8>>> {
        Ok(None)
    }
    pub fn control(_: Control) -> AppResult<()> {
        Err(NA)
    }
    pub fn seek(_: u64) -> AppResult<()> {
        Err(NA)
    }
}

pub use imp::{artwork, control, now_playing, seek};
