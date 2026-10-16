import { useEffect, useRef } from 'react'

/** Fade updated content in place, preserving media playback and form state. */
export function useContentFade<T extends HTMLElement = HTMLElement>(contentKey: string) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const node = ref.current
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
    if (!node || reducedMotion.matches) return
    const animation = node.animate([{ opacity: 0.7 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' })
    const cancel = () => animation.cancel()
    reducedMotion.addEventListener('change', cancel)
    return () => { animation.cancel(); reducedMotion.removeEventListener('change', cancel) }
  }, [contentKey])
  return ref
}
