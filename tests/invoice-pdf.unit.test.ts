import pdfMake from 'pdfmake/build/pdfmake'
import fonts from 'pdfmake/build/vfs_fonts'
import { describe, expect, it } from 'vitest'
import { invoicePdfDefinition } from '../src/services/invoicePdf'
import { buildInvoiceDocument } from '../supabase/functions/_backend/utils/invoice_document'
import { exampleAccount, exampleInvoice, exampleLines, exampleRate } from './fixtures/invoices/example'

describe('invoice PDF rendering', () => {
  it.concurrent('renders long descriptions, accented identities and multiple pages as an actual PDF', async () => {
    const lines = Array.from({ length: 101 }, (_, i) => ({ ...exampleLines[0], description: `Line ${i + 1}: ${'Long subscription description '.repeat(12)}` }))
    const document = buildInvoiceDocument({ ...exampleInvoice, customer_name: 'Example Société' }, exampleAccount, lines, [], new Map([[exampleRate.id, exampleRate]]))
    const pdf = pdfMake.createPdf(invoicePdfDefinition(document), undefined, undefined, fonts as unknown as Record<string, string>)
    const buffer = await new Promise<Uint8Array>(resolve => pdf.getBuffer(resolve))
    const text = new TextDecoder().decode(buffer)
    expect(text.startsWith('%PDF-')).toBe(true)
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1)
  })
  it.concurrent('does not interpret invoice descriptions as HTML or payment URLs', () => {
    const document = buildInvoiceDocument(exampleInvoice, exampleAccount, [{ ...exampleLines[0], description: '<script>alert(1)</script> https://example.com' }], [], new Map())
    const definition = invoicePdfDefinition(document)
    expect(JSON.stringify(definition)).toContain('<script>alert(1)</script>')
    expect(JSON.stringify(definition)).not.toContain('"link":"https://example.com"')
    expect(JSON.stringify(definition)).toContain('https://console.capgo.app/settings/organization/billing')
  })
})
