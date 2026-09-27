// Volume above 100%: an <audio> element's volume stops at 1.0, so louder
// playback routes the element through a Web Audio gain node instead.
//
// Only downloaded songs (data: URLs) are boosted. Web Audio outputs silence
// for cross-origin streams (YouTube URLs) that lack CORS headers, and once an
// element is connected to Web Audio it can't be disconnected, so streamed
// songs stay capped at 100%.

export const MAX_VOLUME = 2

let context: AudioContext | undefined
const gains = new WeakMap<HTMLAudioElement, GainNode>()

function attachGain(audio: HTMLAudioElement): GainNode | undefined {
  try {
    context ??= new AudioContext()
    const source = context.createMediaElementSource(audio)
    const gain = context.createGain()
    source.connect(gain).connect(context.destination)
    gains.set(audio, gain)
    context.resume().catch(() => undefined)
    return gain
  } catch (e) {
    console.log('GTM: volume boost unavailable', e)
    return undefined
  }
}

/** Web Audio can be left suspended after the device sleeps; wake it up. */
export function resumeAudioContext() {
  context?.resume().catch(() => undefined)
}

/**
 * Applies `volume` (0 to MAX_VOLUME) to `audio` and returns the element-level
 * volume (0 to 1) that was set, which callers can fade to.
 */
export function setBoostedVolume(
  audio: HTMLAudioElement,
  volume: number
): number {
  const target = Math.min(
    Math.max(isFinite(volume) ? volume : 1, 0),
    MAX_VOLUME
  )
  let gain = gains.get(audio)
  if (!gain && target > 1 && audio.src.startsWith('data:')) {
    gain = attachGain(audio)
  }
  if (gain) gain.gain.value = Math.max(target, 1)
  const elementVolume = Math.min(target, 1)
  audio.volume = elementVolume
  return elementVolume
}
