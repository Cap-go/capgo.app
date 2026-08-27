import { stderr } from 'node:process'

export function sanitizeCredentialsExportTerminalText(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!
    const unsafe = codePoint <= 0x1F || (codePoint >= 0x7F && codePoint <= 0x9F)
      || (codePoint >= 0x2028 && codePoint <= 0x202E) || (codePoint >= 0x2066 && codePoint <= 0x2069)
    return unsafe ? `\\u${codePoint.toString(16).padStart(4, '0')}` : character
  }).join('')
}

export const quoteCredentialsExportTerminalValue = (value: string | undefined) => sanitizeCredentialsExportTerminalText(JSON.stringify(value ?? ''))

export function writeCredentialsExportStderr(message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stderr.write(message, error => error ? reject(error) : resolve())
  })
}
