import { useEffect, useMemo, useRef, useState } from 'react'
import { useAudioLoaderCompatState } from '../state/AudioLoaderCompatState'
import { setBoostedVolume } from '../lib/audioBoost'

const useAudioPlayer = (
  audioUrl: string | undefined
): {
  play: () => void
  pause: () => void
  stop: () => void
  setVolume: (volume: number) => void
  togglePlay: () => void
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
    isPlaying,
    isReady
  }
}

export default useAudioPlayer
