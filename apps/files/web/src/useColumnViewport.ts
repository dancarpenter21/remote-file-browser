import { useLayoutEffect, useRef, useState } from 'react'
import { columnScrollLeft, columnTrailingSpace } from './finderPath'

/** Keep the viewport anchored even when React removes columns to its right. */
export function useColumnViewport(directoryIds: string[], widths: number[], currentDirectoryId: string, dragging: boolean, navigationRequest: { directoryId: string } | null) {
  const scroller = useRef<HTMLDivElement>(null)
  const columnRefs = useRef<Array<HTMLDivElement | null>>([])
  const [viewport, setViewport] = useState({ left: 0, width: 0 })
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null)
  const handledFocus = useRef(focusRequest)
  const handledNavigation = useRef(navigationRequest)
  const previousPath = useRef(directoryIds)
  const pathKey = JSON.stringify(directoryIds)
  const contentWidth = widths.reduce((sum, width) => sum + width, 0)

  const rememberViewport = () => {
    const container = scroller.current
    if (!container) return
    const next = { left: container.scrollLeft, width: container.clientWidth }
    setViewport(previous => previous.left === next.left && previous.width === next.width ? previous : next)
  }
  const cancelScroll = () => {
    const container = scroller.current
    if (container) container.scrollTo({ left: container.scrollLeft, behavior: 'instant' })
  }

  useLayoutEffect(() => {
    const container = scroller.current
    if (!container) return
    rememberViewport()
    const observer = new ResizeObserver(rememberViewport)
    observer.observe(container)
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotion.addEventListener('change', cancelScroll)
    return () => { observer.disconnect(); reducedMotion.removeEventListener('change', cancelScroll); cancelScroll() }
  }, [])

  useLayoutEffect(() => {
    const container = scroller.current
    if (!container) return
    cancelScroll()
    const focus = handledFocus.current !== focusRequest ? focusRequest : null
    handledFocus.current = focusRequest
    const navigation = handledNavigation.current !== navigationRequest ? navigationRequest : null
    handledNavigation.current = navigationRequest
    const openedColumn = directoryIds.some((id, index) => previousPath.current[index] !== id)
    previousPath.current = directoryIds
    const destination = focus?.id ?? navigation?.directoryId ?? (dragging ? directoryIds.at(-1) : currentDirectoryId)
    const index = directoryIds.indexOf(destination ?? '')
    const column = columnRefs.current[index]
    if (!column) return
    if (focus) column.focus({ preventScroll: true })
    const left = widths.slice(0, index).reduce((sum, width) => sum + width, 0)
    const target = columnScrollLeft(container.scrollLeft, container.clientWidth, left, left + widths[index], Boolean(focus) || openedColumn || navigation?.directoryId === '')
    container.scrollTo({ left: target, behavior: dragging || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }, [pathKey, currentDirectoryId, focusRequest, navigationRequest])

  return {
    scroller, columnRefs,
    trailingSpace: columnTrailingSpace(contentWidth, viewport.left, viewport.width),
    rememberViewport, cancelScroll,
    focusColumn: (id: string) => setFocusRequest({ id }),
  }
}
