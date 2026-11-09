import QRCode from 'qrcode'

/**
 * Handle a custom_msg from the websocket stream.
 * Known kinds get rich rendering; unknown kinds get a warning + raw dump.
 */
export async function handleCustomMsg(
  kind: string,
  data: Record<string, unknown>,
  log: (line: string) => void,
  warn: (line: string) => void,
): Promise<void> {
  if (kind === 'qr_download_link') {
    const url = data.url
    if (typeof url !== 'string') {
      warn('qr_download_link message missing url field')
      return
    }

    try {
      const qrText = await QRCode.toString(url, { type: 'utf8', errorCorrectionLevel: 'L' })
      log('')
      for (const line of qrText.split('\n')) {
        log(line)
      }
      log(url)
      log('')
    }
    catch {
      // Fallback: just show the URL if QR generation fails
      log('')
      log(url)
      log('')
    }
    return
  }

  // Build step progress is meant for the console live page; the terminal already shows the logs.
  if (kind === 'step')
    return

  // Unknown kind — warn and dump raw data
  warn(`Unknown message type "${kind}" — you may need to update the CLI`)
  log(JSON.stringify(data, null, 2))
}
