/* eslint-disable @typescript-eslint/no-explicit-any */

// Sleep, wake and shutdown notifications from Steam. These aren't in the
// typings, so every registration is checked and wrapped; if Steam renames
// one, it's logged and skipped instead of breaking the plugin.
//
// Observed on SteamOS (Sep 2026): pressing the power button fires
// SteamClient.User.RegisterForPrepareForSystemSuspendProgress, and waking
// fires RegisterForResumeSuspendedGamesProgress. The System.RegisterForOn*
// suspend/resume methods other plugins use don't exist on this client.

type Unregister = () => void

// After waking, music fades back in over this long.
export const WAKE_FADE_MS = 1000
// ...starting this long after Steam's startup movie ends.
const AFTER_MOVIE_MS = 1500
// How long to look for a startup movie before assuming there isn't one.
const MOVIE_APPEAR_MS = 1000
// Never wait longer than this for a movie to finish.
const MOVIE_MAX_MS = 20000
const POLL_MS = 200

function register(
  owner: any,
  method: string,
  callback: () => void
): Unregister | undefined {
  try {
    if (typeof owner?.[method] !== 'function') {
      console.log(`GTM: ${method} not available`)
      return undefined
    }
    const handle = owner[method](callback)
    return () => {
      try {
        handle?.unregister?.()
      } catch (e) {
        console.log(`GTM: unregistering ${method} failed`, e)
      }
    }
  } catch (e) {
    console.log(`GTM: registering ${method} failed`, e)
    return undefined
  }
}

// Steam may show the startup movie in more than one <video> at once, so the
// movie counts as playing while any copy is still on screen and not finished.
function startupMoviePlaying(): boolean {
  try {
    const doc: Document | undefined = (window as any).SteamUIStore?.WindowStore
      ?.GamepadUIMainWindowInstance?.BrowserWindow?.document
    return Array.from(doc?.querySelectorAll('video') ?? []).some(
      (v) =>
        (v.currentSrc || v.src).includes('startupmovies') &&
        v.isConnected &&
        !v.ended
    )
  } catch {
    return false
  }
}

/**
 * Runs `callback` 1.5 s after Steam's wake-up startup movie finishes (a
 * <video> from .../startupmovies/ that's removed when it ends). If no movie
 * shows up, it runs shortly after waking instead. Returns a cancel function.
 */
export function afterStartupMovie(callback: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const start = Date.now()
  let sawMovie = false
  const check = () => {
    if (cancelled) return
    const elapsed = Date.now() - start
    const playing = startupMoviePlaying()
    if (playing) sawMovie = true
    const waitMore = playing
      ? elapsed < MOVIE_MAX_MS
      : !sawMovie && elapsed < MOVIE_APPEAR_MS
    if (waitMore) {
      timer = setTimeout(check, POLL_MS)
    } else {
      timer = setTimeout(() => !cancelled && callback(), AFTER_MOVIE_MS)
    }
  }
  check()
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}

/**
 * Calls `onSleep` when the device is about to sleep or shut down, and
 * `onWake` (if given) after it wakes up. Returns a function that removes
 * the listeners.
 */
export function onPowerEvents(handlers: {
  onSleep: () => void
  onWake?: () => void
}): Unregister {
  const user = (window as any).SteamClient?.User
  const unregisters = [
    register(
      user,
      'RegisterForPrepareForSystemSuspendProgress',
      handlers.onSleep
    ),
    register(user, 'RegisterForShutdownStart', handlers.onSleep),
    handlers.onWake &&
      register(user, 'RegisterForResumeSuspendedGamesProgress', handlers.onWake)
  ]
  return () => unregisters.forEach((u) => u?.())
}
