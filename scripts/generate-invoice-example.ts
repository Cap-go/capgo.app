import { mkdir, writeFile } from 'node:fs/promises'
import pdfMake from 'pdfmake/build/pdfmake'
import fonts from 'pdfmake/build/vfs_fonts'
import { invoicePdfDefinition } from '../src/services/invoicePdf'
import { buildInvoiceDocument } from '../supabase/functions/_backend/utils/invoice_document'
import { exampleAccount, exampleInvoice, exampleLines, exampleRate } from '../tests/fixtures/invoices/example'

const document = buildInvoiceDocument(exampleInvoice, exampleAccount, exampleLines, [], new Map([[exampleRate.id, exampleRate]]))
document.notes.push('Illustrative comparison - fictional customer, number and amounts')
const definition = invoicePdfDefinition(document)
const pdf = pdfMake.createPdf(definition, undefined, undefined, fonts as unknown as Record<string, string>)
const buffer = await new Promise<Uint8Array>(resolve => pdf.getBuffer(resolve))
await mkdir('docs/pr-screenshots/owned-invoices', { recursive: true })
await writeFile('docs/pr-screenshots/owned-invoices/after.pdf', buffer)
console.log('Generated fictional invoice example')
