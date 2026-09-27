import { useEffect, useState } from 'react'

import { getResolver } from '../actions/audio'

import { getCache, updateCache } from '../cache/musicCache'
import { useSettings } from '../hooks/useSettings'

const useThemeMusic = (appId: number) => {
  const { settings, isLoading: settingsLoading } = useSettings()
  const [audio, setAudio] = useState<{ videoId: string; audioUrl: string }>({
    videoId: '',
    audioUrl: ''
  })
  const appDetails = appStore.GetAppOverviewByGameID(appId)
  const appName = appDetails?.display_name?.replace(/(™|®|©)/g, '')

  useEffect(() => {
    let ignore = false
    async function getData() {
      const resolver = getResolver(settings.useYtDlp)
      const cache = await getCache(appId)
      if (ignore) return

      // An empty videoId means the user picked "No Music".
      if (cache?.videoId?.length === 0) {
        return setAudio({ videoId: '', audioUrl: '' })
      }

      if (cache?.videoId?.length) {
        const cachedAudio = await resolver.getAudioUrlFromVideo({
          id: cache.videoId
        })
        if (ignore) return
        if (cachedAudio?.length) {
          setAudio({ videoId: cache.videoId, audioUrl: cachedAudio })
          downloadInBackground(cache.videoId, cachedAudio)
          return
        }
        // The saved song couldn't be loaded (eg removed or blocked video).
        // Play a fresh search result instead of going silent, but keep the
        // saved choice so a temporary failure doesn't overwrite it.
        console.log(
          `GTM: saved song ${cache.videoId} for ${appId} failed, searching instead`
        )
        const fallback = await resolver.getAudio(appName as string)
        if (ignore) return
        return setAudio(fallback ?? { videoId: '', audioUrl: '' })
      }

      if (settings.defaultMuted) {
        return setAudio({ videoId: '', audioUrl: '' })
      }

      const newAudio = await resolver.getAudio(appName as string)
      if (ignore) return
      if (!newAudio?.audioUrl?.length) {
        return setAudio({ videoId: '', audioUrl: '' })
      }
      await updateCache(appId, { videoId: newAudio.videoId })
      setAudio(newAudio)
      downloadInBackground(newAudio.videoId, newAudio.audioUrl)
    }

    // Save streamed songs locally so later visits (and play-on-highlight)
    // use the downloaded file instead of YouTube.
    function downloadInBackground(videoId: string, audioUrl: string) {
      if (!settings.useYtDlp || !settings.downloadAudio) return
      if (audioUrl.startsWith('data:')) return // already downloaded
      getResolver(settings.useYtDlp)
        .downloadAudio({ id: videoId })
        .then((ok) => {
          if (ok) console.log(`GTM: downloaded ${videoId} for ${appId}`)
        })
        .catch((e) => console.error('GTM: background download failed', e))
    }

    if (appName?.length && !settingsLoading) {
      getData().catch((e) =>
        console.error('GTM: loading theme music failed', e)
      )
    }
    return () => {
      ignore = true
    }
  }, [appName, settingsLoading])

  return {
    audio
  }
}

export default useThemeMusic
