export const MOBILE_MEDIA_QUERY = '(max-width: 800px)'

type MatchMedia = (query: string) => MediaQueryList

export function observeMobileMode(matchMedia: MatchMedia, onChange: (mobile: boolean) => void) {
  const media = matchMedia(MOBILE_MEDIA_QUERY)
  const changed = () => onChange(media.matches)
  changed()
  media.addEventListener('change', changed)
  return () => media.removeEventListener('change', changed)
}
