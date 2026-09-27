import { useEffect, useMemo, useRef, useState } from 'react'
import { useAudioLoaderCompatState } from '../state/AudioLoaderCompatState'
import { setBoostedVolume } from '../lib/audioBoost'
import { WAKE_FADE_MS } from '../lib/powerEvents'

const useAudioPlayer = (
  audioUrl: string | undefined
): {
  play: () => void
  pause: () => void
  stop: () => void
  setVolume: (volume: number) => void
  togglePlay: () => void
  pauseForSleep: () => boolean
  resumeAfterSleep: () => void
  isPlaying: boolean
  isReady: boolean
} => {
  const { setOnThemePage, onAppPage } = useAudioLoaderCompatState()
  if (!onAppPage) {
    setOnThemePage(true)
  }

  const audioPlayer: HTMLAudioElement = useMemo(() => {
    const audio = new Audio()
    audio.preload = 'auto'
    return audio
  }, [])

  audioPlayer.oncanplaythrough = () => {
    setIsReady(true)
    setOnThemePage(true)
  }

  const [isPlaying, setIsPlaying] = useState(false)
  const [isReady, setIsReady] = useState(false)
  // The volume may be set before the song is known; boosting above 100%
  // depends on the song, so remember it and re-apply when the song changes.
  const wantedVolume = useRef<number | undefined>()

  useEffect(() => {
    if (audioUrl?.length) {
      audioPlayer.src = audioUrl
      audioPlayer.loop = true
      if (wantedVolume.current !== undefined) {
        setBoostedVolume(audioPlayer, wantedVolume.current)
      }
    }
  }, [audioUrl])

  useEffect(() => {
    return () => {
      unload()
    }
  }, [])

  function play() {
    if (audioPlayer.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA) {
      audioPlayer.play()
      setIsPlaying(true)
      setOnThemePage(true)
    }
  }

  function pause() {
    if (!audioPlayer.paused && !audioPlayer.ended) {
      audioPlayer.pause()
      setIsPlaying(false)
    }
  }

  function stop() {
    if (!audioPlayer.paused || audioPlayer.currentTime > 0) {
      audioPlayer.pause()
      audioPlayer.currentTime = 0
      setIsPlaying(false)
    }
  }

  /** Pauses playback; returns whether it was playing. */
  function pauseForSleep(): boolean {
    const wasPlaying = !audioPlayer.paused
    audioPlayer.pause()
    return wasPlaying
  }

  /**
   * Resumes after the device wakes. Unlike play(), this doesn't wait for the
   * "fully loaded" state, which the element may lose while asleep.
   */
  function resumeAfterSleep() {
    if (!audioPlayer.src) return
    const target = setBoostedVolume(audioPlayer, wantedVolume.current ?? 1)
    // Start the song from the beginning after waking.
    audioPlayer.currentTime = 0
    audioPlayer.volume = 0
    audioPlayer
      .play()
      .then(() => {
        setIsPlaying(true)
        setOnThemePage(true)
        // Fade back in rather than jumping straight to full volume.
        const steps = 25
        let step = 0
        const timer = setInterval(() => {
          step++
          audioPlayer.volume = Math.min(target, (target * step) / steps)
          if (step >= steps) clearInterval(timer)
        }, WAKE_FADE_MS / steps)
      })
      .catch((e) => console.log('GTM: resume after sleep failed', e))
  }

  function togglePlay() {
    if (isPlaying) stop()
    else play()
  }

  function setVolume(newVolume: number) {
    wantedVolume.current = newVolume
    setBoostedVolume(audioPlayer, newVolume)
  }

  function unload() {
    stop()
    audioPlayer.src = ''
    setIsPlaying(false)
    setIsReady(false)
    setOnThemePage(false)
  }

  return {
    play,
    pause,
    stop,
    setVolume,
    togglePlay,
    pauseForSleep,
    resumeAfterSleep,
    isPlaying,
    isReady
  }
}

export default useAudioPlayer
