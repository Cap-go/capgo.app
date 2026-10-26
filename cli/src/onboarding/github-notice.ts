import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import process from 'node:process'
import { setupDebug } from './setup-diagnostics'

function escapeMarkdown(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\\`*_{}[\]()!#|]/g, '\\$&')
}

export function renderGitHubNotice(text: string): boolean {
  if (process.env.GITHUB_ACTIONS !== 'true')
    return false
  let noticeWritten = false
  try {
    const escaped = text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
    const annotation = Buffer.from(`::notice::${escaped}\n`)
    for (let offset = 0; offset < annotation.length;) {
      const written = fs.writeSync(1, annotation, offset, annotation.length - offset)
      if (written === 0)
        throw new Error('GitHub notice write made no progress')
      offset += written
    }
    noticeWritten = true
    const summary = process.env.GITHUB_STEP_SUMMARY
    if (summary) {
      const markdown = text.trim().split('\n').map((line, index) => `${index === 0 ? '### ' : ''}${escapeMarkdown(line)}`).join('  \n')
      fs.appendFileSync(summary, `\n${markdown}\n\n`, 'utf8')
    }
  }
  catch {
    // Optional reporting must never fail an otherwise successful deployment.
    setupDebug('GitHub notice output unavailable')
  }
  return noticeWritten
}
