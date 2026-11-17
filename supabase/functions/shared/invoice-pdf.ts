import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'
import type { InvoiceDocument } from './invoice-document'

export const invoiceAssetFiles = ['Inter-Regular.ttf', 'Inter-Medium.ttf', 'Inter-SemiBold.ttf', 'capgo.png']
export const invoiceFonts = {
  Inter: { normal: 'Inter-Regular.ttf', bold: 'Inter-SemiBold.ttf', italics: 'Inter-Regular.ttf', bolditalics: 'Inter-SemiBold.ttf' },
  InterMedium: { normal: 'Inter-Medium.ttf', bold: 'Inter-SemiBold.ttf', italics: 'Inter-Medium.ttf', bolditalics: 'Inter-SemiBold.ttf' },
}

// Match the issued Stripe document's Letter page, Inter typography and table grid.
// All variable content still flows, including long identities and multi-page invoices.
export function invoicePdfDefinition(invoice: InvoiceDocument, billingUrl = 'https://console.capgo.app/settings/organization/billing'): TDocumentDefinitions {
  const textLines = (lines: string[]): Content => ({ stack: lines.map(text => ({ text })), lineHeight: 1.24 })
  const hasTax = invoice.lines.some(line => line.tax)
  const noteText = invoice.notes.join('\n')
  const compactNotes = invoice.notes.length <= 1 && noteText.length <= 65 && !/[\r\n\u2028\u2029]/.test(noteText)
  const bottomMargin = compactNotes && invoice.notes.length ? 82 : 60
  const details = [
    ['Invoice number', invoice.number],
    ['Date of issue', invoice.issued],
    ...(invoice.due ? [['Date due', invoice.due]] : []),
    ...invoice.fields.map(field => [field.name, field.value]),
  ]
  const lineRows = invoice.lines.map((line) => {
    const description: Content[] = [{ text: line.description }]
    if (line.period)
      description.push({ text: line.period, fontSize: 8.25, margin: [0, 3, 0, 0] })
    const cells: TableCell[] = [
      { stack: description },
      { text: line.quantity, alignment: 'right' },
      { text: line.unitPrice, alignment: 'right' },
    ]
    if (hasTax)
      cells.push({ text: line.tax ?? '', alignment: 'right' })
    cells.push({ text: line.amount, alignment: 'right' })
    return cells
  })
  return {
    pageSize: 'LETTER',
    pageMargins: [30, 30.56, 30, bottomMargin],
    info: { title: `Invoice ${invoice.number}`, author: 'Capgo', subject: 'Invoice' },
    defaultStyle: { font: 'Inter', fontSize: 9, color: '#000000', lineHeight: 1 },
    background: () => ({ canvas: [{ type: 'rect', x: 0, y: 0, w: 612, h: 4, color: '#121826' }] }),
    content: [
      { image: 'capgo.png', width: 40.5, height: 40.5, absolutePosition: { x: 541.5, y: 30 } },
      { text: 'Invoice', fontSize: 18, bold: true, margin: [0, 0, 0, 19.19] },
      {
        table: { widths: [73.5, '*'], body: details.map(([label, value], index) => [{ text: label, font: 'InterMedium', bold: index === 0 }, { text: value, font: 'InterMedium', bold: index === 0 }]) },
        layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 2.61 },
      },
      {
        columns: [
          { width: 220.8, stack: [
            { columns: [
              { text: invoice.seller[0] ?? '', width: 'auto', bold: true, margin: [0, 1.5, 0, 0] },
              ...(invoice.seller[0] === 'Capgo'
                ? [{ width: 44, stack: [
                    { canvas: [{ type: 'rect' as const, x: 0, y: 0, w: 44, h: 16.5, r: 8.25, color: '#f4f5f8' }] },
                    { text: '@capgo', relativePosition: { x: 5, y: -14 }, lineHeight: 0 },
                  ] }]
                : []),
            ], columnGap: 4, margin: [0, 0, 0, 3] },
            textLines(invoice.seller.slice(1)),
          ] },
          { stack: [{ text: 'Bill to', bold: true, margin: [0, 0, 0, 9] }, textLines(invoice.customer)] },
        ],
        margin: [0, 15, 0, 26.55],
      },
      { text: invoice.summary, bold: true, fontSize: 14, margin: [0, 0, 0, 7.5] },
      ...(invoice.status === 'open' ? [{ text: 'Pay online', link: billingUrl, color: '#635bff', bold: true, decoration: 'underline', margin: [0, 0, 0, 30.3] } as Content] : [{ text: '', margin: [0, 0, 0, 30.3] } as Content]),
      ...(invoice.description ? [{ text: invoice.description, margin: [0, 0, 0, 16] } as Content] : []),
      {
        table: {
          headerRows: 1,
          widths: hasTax ? ['*', 36, 64.5, 48.75, 60.75] : ['*', 36, 64.5, 60.75],
          body: [
            ['Description', 'Qty', 'Unit price', ...(hasTax ? ['Tax'] : []), 'Amount'].map<TableCell>((text, i) => ({ text, fontSize: 7.5, alignment: i > 0 ? 'right' : 'left' })),
            ...lineRows,
          ],
        },
        layout: {
          hLineWidth: i => i === 1 ? 0.75 : 0,
          vLineWidth: () => 0,
          hLineColor: () => '#000000',
          paddingLeft: () => 0,
          paddingRight: () => 0,
          paddingTop: i => i === 0 ? 0 : 6,
          paddingBottom: () => 6,
        },
      },
      {
        unbreakable: true,
        columns: [{ text: '', width: '*' }, {
          width: 276,
          table: { widths: ['*', 65], body: invoice.totals.map(row => [{ text: row.label, bold: row.strong }, { text: row.amount, bold: row.strong, alignment: 'right' }]) },
          layout: {
            hLineWidth: i => i < invoice.totals.length ? 0.5 : 0,
            vLineWidth: () => 0,
            hLineColor: () => '#dddddd',
            paddingLeft: () => 0,
            paddingRight: () => 0,
            paddingTop: () => 1.5,
            paddingBottom: () => 1.36,
          },
        }],
        margin: [0, 9.36, 0, 20],
      },
      ...(!compactNotes ? invoice.notes.map(text => ({ text, fontSize: 8, margin: [0, 0, 0, 6] } as Content)) : []),
    ],
    footer: (page, pages) => ({
      stack: [
        ...(compactNotes && page === pages && invoice.notes.length ? [{ text: invoice.notes.join('\n'), fontSize: 8, color: '#666666', absolutePosition: { x: 30, y: bottomMargin - 78 } } as Content] : []),
        { canvas: [{ type: 'line', x1: 0, x2: 552, y1: 0, y2: 0, lineWidth: 0.5, lineColor: '#dddddd' }] },
        { columns: [{ text: `${invoice.number} - ${invoice.summary}` }, { text: `Page ${page} of ${pages}`, width: 'auto', alignment: 'right' }], columnGap: 12, margin: [0, 14, 0, 0] },
      ],
      margin: [30, bottomMargin - 60, 30, 0],
      fontSize: 7.5,
    }),
  }
}

