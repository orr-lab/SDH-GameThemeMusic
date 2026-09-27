import {
  DialogButton,
  Focusable,
  SliderField,
  PanelSectionRow,
  useParams
} from '@decky/ui'
import { useEffect, useState } from 'react'
import { getCache, updateCache } from '../../cache/musicCache'

import { getResolver } from '../../actions/audio'
import useTranslations from '../../hooks/useTranslations'
import { useSettings } from '../../hooks/useSettings'
import { FaHourglassHalf, FaVolumeUp } from 'react-icons/fa'
import Spinner from '../spinner'
import useAudioPlayer from '../../hooks/useAudioPlayer'
import { MAX_VOLUME } from '../../lib/audioBoost'

export default function GameSettings() {
  const t = useTranslations()
  const { settings, isLoading: settingsIsLoading } = useSettings()
  const { appid } = useParams<{ appid: string }>()
  const appDetails = appStore.GetAppOverviewByGameID(parseInt(appid))
  const appName = appDetails?.display_name

  const [currentAudio, setCurrentAudio] = useState<string>()
  const [themeVolume, setThemeVolume] = useState(settings.volume)
  const [pageDelay, setPageDelay] = useState(settings.pageDelay)
  const [highlightDelay, setHighlightDelay] = useState(settings.highlightDelay)
  const [loading, setLoading] = useState(true)

  const audioPlayer = useAudioPlayer(currentAudio)

  useEffect(() => {
    async function getData() {
      setLoading(true)
      const resolver = getResolver(settings.useYtDlp)
      const cache = await getCache(parseInt(appid))
      if (typeof cache?.volume === 'number' && isFinite(cache.volume)) {
        setThemeVolume(cache.volume)
      } else {
        setThemeVolume(settings.volume)
      }
      setPageDelay(
        typeof cache?.pageDelay === 'number' && isFinite(cache.pageDelay)
          ? cache.pageDelay
          : settings.pageDelay
      )
      setHighlightDelay(
        typeof cache?.highlightDelay === 'number' &&
          isFinite(cache.highlightDelay)
          ? cache.highlightDelay
          : settings.highlightDelay
      )
      if (cache?.videoId?.length) {
        const newAudio = await resolver.getAudioUrlFromVideo({
          id: cache?.videoId
        })
        setCurrentAudio(newAudio)
      } else {
        const newAudio = await resolver.getAudio(appName as string)
        setCurrentAudio(newAudio?.audioUrl)
      }
      setLoading(false)
    }
    if (!settingsIsLoading) {
      getData()
    }
  }, [appid, settingsIsLoading])

  function updateThemeVolume(newVol: number, reset?: boolean) {
    setThemeVolume(newVol)
    audioPlayer.setVolume(newVol)
    updateCache(parseInt(appid), { volume: reset ? undefined : newVol })
  }

  function updatePageDelay(value: number) {
    const rounded = Math.round(value * 10) / 10
    setPageDelay(rounded)
    updateCache(parseInt(appid), { pageDelay: rounded })
  }

  function updateHighlightDelay(value: number) {
    setHighlightDelay(value)
    updateCache(parseInt(appid), { highlightDelay: value })
  }

  function resetDelays() {
    setPageDelay(settings.pageDelay)
    setHighlightDelay(settings.highlightDelay)
    updateCache(parseInt(appid), {
      pageDelay: undefined,
      highlightDelay: undefined
    })
  }

  return (
    <div>
      <h2 style={{ margin: '20px 0' }}>{appName}</h2>

      <Focusable
        style={{
          background: 'var(--main-editor-bg-color)',
          borderRadius: '6px',
          display: 'grid',
          gridGap: '16px',
          gridTemplateColumns: '2fr max-content max-content',
          height: 'max-content',
          padding: '10px 10px 10px 16px',
          alignItems: 'center'
        }}
      >
        <div style={{ padding: '0 10px' }}>
          <PanelSectionRow>
            <SliderField
              layout="below"
              bottomSeparator="none"
              label={t('volume')}
              description={
                themeVolume > 1
                  ? t('gameVolumeBoostDescription')
                  : t('gameVolumeDescription')
              }
              value={themeVolume * 100}
              onChange={(newVal) => updateThemeVolume(newVal / 100)}
              min={0}
              max={MAX_VOLUME * 100}
              step={1}
              icon={<FaVolumeUp />}
              editableValue
            />
          </PanelSectionRow>
        </div>
        <DialogButton
          onClick={audioPlayer.togglePlay}
          disabled={loading}
          focusable={!loading}
          style={{ height: 'max-content' }}
        >
          {loading ? (
            <Spinner />
          ) : audioPlayer.isPlaying ? (
            t('stop')
          ) : (
            t('play')
          )}
        </DialogButton>
        <DialogButton
          onClick={() => updateThemeVolume(settings.volume, true)}
          style={{ height: 'max-content' }}
        >
          {t('resetVolume')}
        </DialogButton>
      </Focusable>

      <Focusable
        style={{
          background: 'var(--main-editor-bg-color)',
          borderRadius: '6px',
          display: 'grid',
          gridGap: '16px',
          gridTemplateColumns: '2fr max-content',
          height: 'max-content',
          marginTop: '10px',
          padding: '10px 10px 10px 16px',
          alignItems: 'center'
        }}
      >
        <div style={{ padding: '0 10px' }}>
          <PanelSectionRow>
            <SliderField
              layout="below"
              label={t('pageDelay')}
              description={t('gamePageDelayDescription')}
              value={pageDelay}
              onChange={updatePageDelay}
              min={0}
              max={1}
              step={0.1}
              icon={<FaHourglassHalf />}
              showValue
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <SliderField
              layout="below"
              bottomSeparator="none"
              label={t('highlightDelay')}
              description={
                highlightDelay === 0
                  ? t('highlightDelayZeroWarning')
                  : t('gameHighlightDelayDescription')
              }
              value={highlightDelay}
              onChange={updateHighlightDelay}
              min={0}
              max={5}
              step={0.25}
              icon={<FaHourglassHalf />}
              showValue
            />
          </PanelSectionRow>
        </div>
        <DialogButton onClick={resetDelays} style={{ height: 'max-content' }}>
          {t('resetVolume')}
        </DialogButton>
      </Focusable>
    </div>
  )
}
