export interface EmailContent {
  subject: string
  html: string
  text: string
}

function render(source: string, details: Record<string, string>, escape: (value: string) => string, optionalFields: readonly string[]) {
  return source.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_match, key: string) => {
    const value = details[key]
    if (value === undefined || (!value && !optionalFields.includes(key)))
      throw new Error(`Missing email template value: ${key}`)
    return escape(value)
  })
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  })[char] ?? char)
}

export function renderEmailTemplate(template: EmailContent, details: Record<string, string>, optionalFields: readonly string[] = []): EmailContent {
  return {
    subject: render(template.subject, details, value => value.replace(/[\r\n]+/g, ' '), optionalFields),
    html: render(template.html, details, escapeHtml, optionalFields),
    text: render(template.text, details, value => value, optionalFields),
  }
}
