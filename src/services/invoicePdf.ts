import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'
import type { InvoiceDocument } from '../../supabase/functions/shared/invoice-document'

// Layout adapted from Cap-go/worker-invoices src/pdf.ts. Amounts and identities
// come from the finalized invoice, never today's customer or subscription.
export function invoicePdfDefinition(invoice: InvoiceDocument, billingUrl = 'https://console.capgo.app/settings/organization/billing'): TDocumentDefinitions {
  const textLines = (lines: string[]): Content => ({ stack: lines.map(text => ({ text, margin: [0, 0, 0, 3] })) })
  return {
    pageSize: 'A4',
    pageMargins: [42, 42, 42, 55],
    info: { title: `Invoice ${invoice.number}`, author: 'Capgo', subject: 'Invoice' },
    defaultStyle: { font: 'Roboto', fontSize: 10, color: '#202124', lineHeight: 1.25 },
    content: [
      { columns: [{ text: 'Invoice', fontSize: 26, bold: true }, { text: 'capgo', alignment: 'right', fontSize: 24, bold: true }], margin: [0, 0, 0, 24] },
      { text: [{ text: 'Invoice number   ', bold: true }, invoice.number] },
      { text: [{ text: 'Date of issue       ', bold: true }, invoice.issued] },
      ...(invoice.due ? [{ text: [{ text: 'Date due               ', bold: true }, invoice.due] }] : []),
      ...invoice.fields.map(field => ({ text: [{ text: `${field.name}   `, bold: true }, field.value] })),
      { columns: [textLines(invoice.seller), { stack: [{ text: 'Bill to', bold: true, margin: [0, 0, 0, 4] }, textLines(invoice.customer)] }], columnGap: 30, margin: [0, 24, 0, 24] },
      { text: invoice.summary, bold: true, fontSize: 18, margin: [0, 0, 0, 16] },
      ...(invoice.status === 'open' ? [{ text: 'Pay online', link: billingUrl, color: '#635bff', margin: [0, 0, 0, 18] } as Content] : []),
      ...(invoice.description ? [{ text: invoice.description, margin: [0, 0, 0, 16] } as Content] : []),
      {
        table: {
          headerRows: 1,
          widths: ['*', 28, 90, 90],
          body: [
            ['Description', 'Qty', 'Unit price', 'Amount'].map<TableCell>((text, i) => ({ text, bold: true, alignment: i > 0 ? 'right' : 'left' })),
            ...invoice.lines.map<TableCell[]>(line => [
              { stack: [{ text: line.description }, { text: line.period, color: '#666666', fontSize: 9, margin: [0, 3, 0, 0] }] },
              { text: line.quantity, alignment: 'right' },
              { text: line.unitPrice, alignment: 'right' },
              { text: line.amount, alignment: 'right' },
            ]),
          ],
        },
        layout: { hLineWidth: () => 0.5, vLineWidth: () => 0, hLineColor: () => '#dddddd', paddingTop: () => 5, paddingBottom: () => 5 },
      },
      {
        columns: [{ text: '', width: '*' }, {
          width: 290,
          table: { widths: ['*', 100], body: invoice.totals.map(row => [{ text: row.label, bold: row.strong }, { text: row.amount, bold: row.strong, alignment: 'right' }]) },
          layout: { hLineWidth: () => 0.5, vLineWidth: () => 0, hLineColor: () => '#dddddd', paddingTop: () => 5, paddingBottom: () => 5 },
        }],
        margin: [0, 16, 0, 20],
      },
      ...invoice.notes.map(text => ({ text, fontSize: 9, color: '#555555', margin: [0, 0, 0, 6] } as Content)),
    ],
    footer: (page, pages) => ({ columns: [{ text: invoice.number }, { text: `Page ${page} of ${pages}`, alignment: 'right' }], margin: [42, 18, 42, 0], fontSize: 8, color: '#666666' }),
  }
}

export async function downloadInvoicePdf(invoice: InvoiceDocument, orgId: string) {
  const [{ default: pdfMake }, { default: fonts }] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')])
  // pdfmake 0.2.20 exports the VFS directly; DefinitelyTyped still declares the older wrapper.
  const billingUrl = new URL('/settings/organization/billing', window.location.origin)
  billingUrl.searchParams.set('oid', orgId)
  await new Promise<void>((resolve) => {
    pdfMake.createPdf(invoicePdfDefinition(invoice, billingUrl.toString()), undefined, undefined, fonts as unknown as Record<string, string>)
      .download(`invoice-${invoice.number.replace(/[^\w-]/g, '_')}.pdf`, resolve)
  })
}
