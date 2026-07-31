import { toSvg } from 'better-qr'

const PREVIEW_QR_CODE_OPTIONS = {
  background: '#ffffff',
  foreground: '#000000',
  margin: 2,
  moduleSize: 4,
}

export function buildPreviewQrCodeDataUrl(value: string) {
  const svg = toSvg(value, PREVIEW_QR_CODE_OPTIONS)
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
