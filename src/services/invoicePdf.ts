import type { InvoiceDocument } from '../../supabase/functions/shared/invoice-document'
import { invoiceAssetFiles, invoiceFonts, invoicePdfDefinition } from '../../supabase/functions/shared/invoice-pdf'

export { invoiceAssetFiles, invoiceFonts, invoicePdfDefinition } from '../../supabase/functions/shared/invoice-pdf'

export async function downloadInvoicePdf(invoice: InvoiceDocument, orgId: string, canDownload: () => boolean = () => true) {
  if (!canDownload())
    return
  const [{ default: pdfMake }, { saveAs }, assets] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('file-saver'),
    Promise.all(invoiceAssetFiles.map(async (name) => {
      const response = await fetch(new URL(`/invoice/${name}`, window.location.origin), { signal: AbortSignal.timeout(30_000) })
      if (!response.ok)
        throw new Error(`Failed to load invoice asset: ${name}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      let binary = ''
      for (const byte of bytes)
        binary += String.fromCodePoint(byte)
      return [name, btoa(binary)]
    })),
  ])
  if (!canDownload())
    return
  const billingUrl = new URL('/settings/organization/billing', window.location.origin)
  billingUrl.searchParams.set('oid', orgId)
  // Assets are already local. The synchronous stream API exposes font/layout
  // failures that pdfmake's callback-only download API otherwise swallows.
  const stream = pdfMake.createPdf(invoicePdfDefinition(invoice, billingUrl.toString()), undefined, invoiceFonts, Object.fromEntries(assets)).getStream()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let blob: Blob
  try {
    blob = await new Promise<Blob>((resolve, reject) => {
      const chunks: Uint8Array<ArrayBuffer>[] = []
      stream.on('data', (chunk: Uint8Array) => chunks.push(new Uint8Array(chunk)))
      stream.on('error', reject)
      stream.on('end', () => resolve(new Blob(chunks, { type: 'application/pdf' })))
      timeout = setTimeout(() => {
        reject(new Error('Invoice PDF rendering timed out'))
        stream.destroy()
      }, 60_000)
      stream.end()
    })
  }
  finally {
    clearTimeout(timeout)
  }
  if (!canDownload())
    return
  saveAs(blob, `invoice-${invoice.number.replace(/[^\w-]/g, '_')}.pdf`)
}
