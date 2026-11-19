import type { InvoiceDocument } from '../../../supabase/functions/shared/invoice-document.ts'
import { Buffer } from 'node:buffer'
import pdfMake from 'pdfmake/build/pdfmake'
import { invoiceAssetFiles, invoiceFonts, invoicePdfDefinition } from '../../../supabase/functions/shared/invoice-pdf.ts'

export async function renderInvoiceAttachment(document: InvoiceDocument, billingUrl: string, assetOrigin: string) {
  const assets = await Promise.all(invoiceAssetFiles.map(async (name) => {
    const response = await fetch(new URL(`/invoice/${name}`, assetOrigin), { signal: AbortSignal.timeout(8000) })
    if (!response.ok)
      throw new Error('Invoice asset unavailable')
    return [name, Buffer.from(await response.arrayBuffer()).toString('base64')]
  }))
  const stream = pdfMake.createPdf(invoicePdfDefinition(document, billingUrl), undefined, invoiceFonts, Object.fromEntries(assets)).getStream()
  return await new Promise<string>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    const timer = setTimeout(() => {
      reject(new Error('Invoice PDF rendering timed out'))
      stream.destroy()
    }, 10000)
    stream.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    stream.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
    stream.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('base64'))
    })
    stream.end()
  })
}

