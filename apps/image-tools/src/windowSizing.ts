export function fitImageWindow(imageWidth: number, imageHeight: number, maxWidth: number, maxHeight: number, chromeHeight: number) {
  if (![imageWidth, imageHeight, maxWidth, maxHeight].every(value => Number.isFinite(value) && value > 0)) return undefined
  const availableImageHeight = Math.max(1, maxHeight - chromeHeight)
  const scale = Math.min(1, maxWidth / imageWidth, availableImageHeight / imageHeight)
  return {
    width: Math.min(maxWidth, Math.max(360, Math.round(imageWidth * scale))),
    height: Math.min(maxHeight, Math.max(260, Math.round(imageHeight * scale + chromeHeight))),
  }
}
