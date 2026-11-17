import { readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { afterEach, expect, it, vi } from 'vitest'
import { renderInvoiceAttachment } from '../cloudflare_workers/api/email_templates/invoice_pdf'
import { buildInvoiceDocument } from '../supabase/functions/_backend/utils/invoice_document'
import { exampleAccount, exampleInvoice, exampleLines } from './fixtures/invoices/example'

afterEach(() => vi.unstubAllGlobals())
it('attaches a readable PDF with the same invoice number and content as console downloads', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => new Response(readFileSync(`public${url.pathname}`))))
  const document = buildInvoiceDocument(exampleInvoice, exampleAccount, exampleLines, [], new Map())
  const content = await renderInvoiceAttachment(document, 'https://example.com/billing', 'https://example.com')
  const task = getDocument({ data: Uint8Array.from(Buffer.from(content, 'base64')) })
  const pdf = await task.promise
  try {
    const page = await pdf.getPage(1)
    const text = (await page.getTextContent()).items.filter(item => 'str' in item).map(item => item.str).join(' ')
    expect(text).toContain(document.number)
    expect(text).toContain(document.summary)
  }
  finally {
    await task.destroy()
  }
})
it('fails delivery when a required PDF asset cannot be loaded', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
  const document = buildInvoiceDocument(exampleInvoice, exampleAccount, exampleLines, [], new Map())
  await expect(renderInvoiceAttachment(document, 'https://example.com/billing', 'https://example.com')).rejects.toThrow('Invoice asset unavailable')
})
