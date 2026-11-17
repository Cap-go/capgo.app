import { readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfMake from 'pdfmake/build/pdfmake'
import { describe, expect, it } from 'vitest'
import { invoiceAssetFiles, invoiceFonts, invoicePdfDefinition } from '../src/services/invoicePdf'
import { buildInvoiceDocument } from '../supabase/functions/_backend/utils/invoice_document'
import { exampleAccount, exampleInvoice, exampleLines, exampleRate, invoiceScenario, invoiceScenarios } from './fixtures/invoices/example'

const assets = Object.fromEntries(invoiceAssetFiles.map(name => [name, btoa(Array.from(readFileSync(`public/invoice/${name}`), byte => String.fromCharCode(byte)).join(''))]))

async function renderedPages(document: ReturnType<typeof buildInvoiceDocument>) {
  const pdf = pdfMake.createPdf(invoicePdfDefinition(document), undefined, invoiceFonts, assets)
  const stream = pdf.getStream()
  const buffer = await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    stream.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.end()
  })
  const task = getDocument({ data: new Uint8Array(buffer) })
  const parsed = await task.promise
  try {
    return await Promise.all(Array.from({ length: parsed.numPages }, async (_, i) => {
      const page = await parsed.getPage(i + 1)
      const content = await page.getTextContent()
      return content.items.filter(item => 'str' in item)
    }))
  }
  finally {
    await task.destroy()
  }
}

describe('invoice PDF rendering', () => {
  it.concurrent.each(invoiceScenarios)('renders the $name period, quantity and paid amount into the PDF', async (scenario) => {
    const { invoice, lines } = invoiceScenario(scenario)
    const document = buildInvoiceDocument(invoice, exampleAccount, lines, [], new Map([[exampleRate.id, exampleRate]]))
    const pages = await renderedPages(document)
    const text = pages.flat().map(item => item.str).join(' ').replace(/\s+/g, ' ')
    expect(text).toContain(scenario.description)
    expect(text).toContain(scenario.period)
    expect(text).toContain(scenario.price)
    expect(text).toContain(`${scenario.amount} paid`)
    expect(pages.flat().map(item => item.str)).toContain(String(scenario.quantity))
  })
  it.concurrent('retains the final description line when a single row spans pages', async () => {
    const description = [...Array.from({ length: 100 }, (_, i) => `Detail ${i + 1}`), 'FINAL DESCRIPTION MARKER'].join('\n')
    const document = buildInvoiceDocument(exampleInvoice, exampleAccount, [{ ...exampleLines[0], description }], [], new Map())
    const pages = await renderedPages(document)
    expect(pages.length).toBeGreaterThan(1)
    const text = pages.flat().map(item => item.str).join(' ')
    expect(text).toContain('Detail 1')
    expect(text).toContain('Detail 100')
    expect(text).toContain('FINAL DESCRIPTION MARKER')
  })
  it.concurrent.each(['\n', '\r\n'])('keeps multiline notes above the fixed footer (%j)', async (newline) => {
    const document = buildInvoiceDocument({ ...exampleInvoice, footer: ['One', 'Two', 'Three', 'Four', 'Five'].join(newline) }, exampleAccount, exampleLines, [], new Map())
    const pages = await renderedPages(document)
    const notes = pages.flat().filter(item => ['One', 'Two', 'Three', 'Four', 'Five'].includes(item.str))
    expect(notes.map(item => item.str)).toEqual(['One', 'Two', 'Three', 'Four', 'Five'])
    expect(Math.min(...notes.map(item => item.transform[5]))).toBeGreaterThan(60)
  })
  it.concurrent('renders long descriptions, accented identities and multiple pages as an actual PDF', async () => {
    const lines = Array.from({ length: 101 }, (_, i) => ({ ...exampleLines[0], description: `Line ${i + 1}: ${'Long subscription description '.repeat(12)}` }))
    const document = buildInvoiceDocument({ ...exampleInvoice, customer_name: 'Example Société' }, exampleAccount, lines, [], new Map([[exampleRate.id, exampleRate]]))
    const pdf = pdfMake.createPdf(invoicePdfDefinition(document), undefined, invoiceFonts, assets)
    const buffer = await new Promise<Uint8Array>(resolve => pdf.getBuffer(resolve))
    const text = new TextDecoder().decode(buffer)
    expect(text.startsWith('%PDF-')).toBe(true)
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1)
  })
  it.concurrent('renders the reference invoice on one Letter page with embedded Inter fonts', async () => {
    const document = buildInvoiceDocument(exampleInvoice, exampleAccount, exampleLines, [], new Map([[exampleRate.id, exampleRate]]))
    const pdf = pdfMake.createPdf(invoicePdfDefinition(document), undefined, invoiceFonts, assets)
    const buffer = await new Promise<Uint8Array>(resolve => pdf.getBuffer(resolve))
    const text = new TextDecoder().decode(buffer)
    expect(text).toContain('/MediaBox [0 0 612 792]')
    expect(text).toContain('Inter-Regular')
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBe(1)
  })
  it.concurrent('does not interpret invoice descriptions as HTML or payment URLs', () => {
    const document = buildInvoiceDocument(exampleInvoice, exampleAccount, [{ ...exampleLines[0], description: '<script>alert(1)</script> https://example.com' }], [], new Map())
    const definition = invoicePdfDefinition(document)
    expect(JSON.stringify(definition)).toContain('<script>alert(1)</script>')
    expect(JSON.stringify(definition)).not.toContain('"link":"https://example.com"')
    expect(JSON.stringify(definition)).toContain('https://console.capgo.app/settings/organization/billing')
  })
})
