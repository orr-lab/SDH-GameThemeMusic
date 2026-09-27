import { useParams } from '@decky/ui'
import { ReactElement, useEffect, useState } from 'react'

import useThemeMusic from '../../hooks/useThemeMusic'
import { useSettings } from '../../hooks/useSettings'
import { getCache } from '../../cache/musicCache'
import useAudioPlayer from '../../hooks/useAudioPlayer'
import { adoptHoverPlayback } from '../../lib/hoverPlayer'

export default function ThemePlayer(): ReactElement {
  const { settings, isLoading: settingsIsLoading } = useSettings()
  const { appid } = useParams<{ appid: string }>()
  // If this game's song is already playing from the library highlight,
  // let it continue instead of starting it again from the beginning.
  const [continuesHover] = useState(() => adoptHoverPlayback(parseInt(appid)))
  const { audio } = useThemeMusic(parseInt(appid))
  const audioPlayer = useAudioPlayer(audio.audioUrl)
  // Per-game page delay override (seconds), loaded from the cache.
  const [gamePageDelay, setGamePageDelay] = useState<number | undefined>()

  useEffect(() => {
    async function getData() {
      const cache = await getCache(parseInt(appid))
      if (typeof cache?.pageDelay === 'number' && isFinite(cache.pageDelay)) {
        setGamePageDelay(cache.pageDelay)
      }
      if (typeof cache?.volume === 'number' && isFinite(cache.volume)) {
        audioPlayer.setVolume(cache.volume)
      } else {
        audioPlayer.setVolume(settings.volume)
      }
    }
    if (!settingsIsLoading) {
      getData()
    }
  }, [settingsIsLoading])

  useEffect(() => {
    if (continuesHover) return undefined
    if (audio?.audioUrl?.length && audioPlayer.isReady) {
      // Start just after Steam's page-opening animation instead of during it.
      const delay = Math.min(
        Math.max(gamePageDelay ?? settings.pageDelay, 0),
        1
      )
      const timer = setTimeout(() => audioPlayer.play(), delay * 1000)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [audio?.audioUrl, audioPlayer.isReady])

  return <></>
}
