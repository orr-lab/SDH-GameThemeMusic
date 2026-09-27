/* eslint-disable @typescript-eslint/no-explicit-any */
import { call } from '@decky/api'

import { getCache } from '../cache/musicCache'
import { setBoostedVolume } from './audioBoost'
import { AudioLoaderCompatState } from '../state/AudioLoaderCompatState'
import {
  Settings,
  defaultSettings,
  loadSettings,
  settingsEvents
} from '../hooks/useSettings'

// Play-on-highlight: when a game tile in the library (grid, tabs, home shelves)
// stays focused for a few seconds, fade in that game's already-downloaded theme.
//
// Discovery notes (Steam client, Sep 2026):
// - Gamepad navigation moves real DOM focus, so `focusin` fires on the main
//   Big Picture window's document for every highlight change.
// - Library grid and "Recent games" tiles carry `app` (an app overview) about
//   10 fibers above the focused element. "Trending among friends" tiles carry a
//   bare numeric `appid` prop about 4 fibers up. News/update cards carry
//   `event` / `item` and are deliberately ignored.
// - The current route is at GamepadUIMainWindowInstance.m_history.location.

const FADE_IN_MS = 400
const FADE_OUT_MS = 300
const FADE_STEP_MS = 20
const MAX_FIBER_DEPTH = 12
// Recently played songs kept in memory (each can be ~10 MB), freed when a game starts.
const DATA_URL_CACHE_SIZE = 3

const log = (...args: unknown[]) => console.log('GTM:', ...args)

function getMainWindowInstance(): any {
  return (window as any).SteamUIStore?.WindowStore?.GamepadUIMainWindowInstance
}

function getRoute(): string | undefined {
  try {
    return getMainWindowInstance()?.m_history?.location?.pathname
  } catch {
    return undefined
  }
}

function isHoverRoute(route: string | undefined): boolean {
  if (!route) return false
  return route.startsWith('/library') && !route.startsWith('/library/app/')
}

function appIdFromElement(el: Element): number | undefined {
  const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
  let fiber = fiberKey ? (el as any)[fiberKey] : undefined
  for (let depth = 0; fiber && depth < MAX_FIBER_DEPTH; depth++) {
    const props = fiber.memoizedProps
    if (props && typeof props === 'object') {
      for (const key of ['app', 'overview']) {
        const appid = props[key]?.appid
        if (typeof appid === 'number' && appid > 0) return appid
      }
      if (typeof props.appid === 'number' && props.appid > 0) return props.appid
    }
    fiber = fiber.return
  }
  return undefined
}

export class HoverPlayer {
  private settings: Settings = defaultSettings
  private audio = new Audio()
  private doc: Document | undefined
  private unlistenHistory: (() => void) | undefined
  private attachRetry: ReturnType<typeof setTimeout> | undefined
  private delayTimer: ReturnType<typeof setTimeout> | undefined
  private fadeTimer: ReturnType<typeof setInterval> | undefined
  // Bumped on every focus change / stop so stale async work is discarded.
  private generation = 0
  private playingAppId: number | undefined
  private dataUrls = new Map<string, string>()
  private destroyed = false

  constructor(private state: AudioLoaderCompatState) {
    this.audio.loop = true
    this.audio.preload = 'auto'
  }

  start() {
    settingsEvents.addEventListener('change', this.onSettingsChange)
    this.state.eventBus.addEventListener('stateUpdate', this.onStateUpdate)
    loadSettings()
      .then((s) => {
        this.settings = s
      })
      .catch((e) => log('could not load settings', e))
    this.attach(0)
  }

  destroy() {
    this.destroyed = true
    clearTimeout(this.attachRetry)
    settingsEvents.removeEventListener('change', this.onSettingsChange)
    this.state.eventBus.removeEventListener('stateUpdate', this.onStateUpdate)
    try {
      this.doc?.removeEventListener('focusin', this.onFocusIn, true)
      this.unlistenHistory?.()
    } catch (e) {
      log('detach failed', e)
    }
    this.stopNow()
    this.dataUrls.clear()
  }

  private attach(attempt: number) {
    if (this.destroyed) return
    try {
      const instance = getMainWindowInstance()
      const doc: Document | undefined = instance?.BrowserWindow?.document
      if (doc) {
        this.doc = doc
        doc.addEventListener('focusin', this.onFocusIn, true)
        const history = instance.m_history
        if (typeof history?.listen === 'function') {
          const unlisten = history.listen(this.onRouteChange)
          if (typeof unlisten === 'function') this.unlistenHistory = unlisten
        }
        log('hover player attached')
        return
      }
    } catch (e) {
      log('attach failed', e)
    }
    if (attempt < 30) {
      this.attachRetry = setTimeout(() => this.attach(attempt + 1), 2000)
    } else {
      log('main window not found, play on highlight disabled')
    }
  }

  private onSettingsChange = (e: Event) => {
    const detail = (e as CustomEvent<Settings>).detail
    if (!detail) return
    this.settings = { ...defaultSettings, ...detail }
    if (!this.settings.playOnHighlight) this.stop()
  }

  private onStateUpdate = () => {
    try {
      if (this.state.getPublicState().gamesRunning.length > 0) {
        this.stop()
        this.dataUrls.clear()
      }
    } catch (e) {
      log('state update failed', e)
    }
  }

  private onRouteChange = () => {
    if (!isHoverRoute(getRoute())) this.stop()
  }

  private onFocusIn = (e: FocusEvent) => {
    try {
      // Every focus change resets the timer and fades out what's playing.
      this.stop()
      if (!this.settings.playOnHighlight) return
      const target = e.target as Element | null
      if (!target) return
      const appId = appIdFromElement(target)
      if (!appId) return
      const generation = this.generation
      const focusedAt = performance.now()
      getCache(appId)
        .then((cache) => {
          if (generation !== this.generation) return
          // Games without a saved song can never play, so don't start a timer.
          if (!cache?.videoId?.length) return
          const seconds =
            typeof cache.highlightDelay === 'number' &&
            isFinite(cache.highlightDelay)
              ? cache.highlightDelay
              : this.settings.highlightDelay
          const delayMs = Math.min(Math.max(seconds, 0), 5) * 1000
          const remaining = Math.max(
            0,
            delayMs - (performance.now() - focusedAt)
          )
          this.delayTimer = setTimeout(
            () => this.onDelayElapsed(appId, target, generation),
            remaining
          )
        })
        .catch((err) => log('cache lookup failed', err))
    } catch (err) {
      log('focus handler failed', err)
    }
  }

  private async onDelayElapsed(
    appId: number,
    target: Element,
    generation: number
  ) {
    try {
      if (!this.canPlay(target, generation)) return
      const cache = await getCache(appId)
      const videoId = cache?.videoId
      if (!videoId?.length) return
      const url = await this.getLocalAudio(videoId)
      if (!url || !this.canPlay(target, generation)) return
      const volume =
        typeof cache?.volume === 'number' && isFinite(cache.volume)
          ? cache.volume
          : this.settings.volume
      log(`playing highlight theme for ${appId}`)
      this.playingAppId = appId
      this.state.setHoverPlaying(true)
      this.audio.src = url
      this.audio.currentTime = 0
      // Volumes above 100% are applied by a gain node; the element volume
      // (0 to 1) is what we fade.
      const fadeTarget = setBoostedVolume(this.audio, volume)
      this.audio.volume = 0
      await this.audio.play()
      if (generation !== this.generation) return
      this.fadeTo(fadeTarget, FADE_IN_MS)
    } catch (e) {
      log('highlight playback failed', e)
      if (generation === this.generation) {
        this.playingAppId = undefined
        this.pauseAudio()
      }
    }
  }

  private canPlay(target: Element, generation: number): boolean {
    return (
      !this.destroyed &&
      generation === this.generation &&
      this.settings.playOnHighlight &&
      isHoverRoute(getRoute()) &&
      this.doc?.activeElement === target &&
      this.state.getPublicState().gamesRunning.length === 0
    )
  }

  private async getLocalAudio(videoId: string): Promise<string | undefined> {
    const cached = this.dataUrls.get(videoId)
    if (cached) return cached
    const url = await call<[string], string | null>('local_yt_audio', videoId)
    if (!url) return undefined
    this.dataUrls.set(videoId, url)
    if (this.dataUrls.size > DATA_URL_CACHE_SIZE) {
      const oldest = this.dataUrls.keys().next().value
      if (oldest !== undefined) this.dataUrls.delete(oldest)
    }
    return url
  }

  private fadeTo(target: number, durationMs: number, onDone?: () => void) {
    clearInterval(this.fadeTimer)
    const start = this.audio.volume
    const steps = Math.max(1, Math.round(durationMs / FADE_STEP_MS))
    let step = 0
    this.fadeTimer = setInterval(() => {
      step++
      try {
        this.audio.volume = Math.min(
          Math.max(start + ((target - start) * step) / steps, 0),
          1
        )
      } catch {
        // ignore
      }
      if (step >= steps) {
        clearInterval(this.fadeTimer)
        this.fadeTimer = undefined
        onDone?.()
      }
    }, FADE_STEP_MS)
  }

  /** Cancel any pending highlight and fade out whatever is playing. */
  private stop() {
    this.generation++
    clearTimeout(this.delayTimer)
    this.delayTimer = undefined
    if (this.playingAppId === undefined) return
    this.playingAppId = undefined
    this.fadeTo(0, FADE_OUT_MS, () => {
      // Only pause if nothing new started during the fade.
      if (this.playingAppId === undefined) this.pauseAudio()
    })
  }

  private stopNow() {
    this.generation++
    clearTimeout(this.delayTimer)
    clearInterval(this.fadeTimer)
    this.playingAppId = undefined
    this.pauseAudio()
  }

  private pauseAudio() {
    try {
      this.audio.pause()
      this.audio.removeAttribute('src')
      this.audio.load()
    } catch (e) {
      log('pause failed', e)
    }
    this.state.setHoverPlaying(false)
  }
}
