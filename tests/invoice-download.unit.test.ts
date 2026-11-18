// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadInvoicePdf } from '../src/services/invoicePdf'
import { buildInvoiceDocument } from '../supabase/functions/_backend/utils/invoice_document'
import { exampleAccount, exampleInvoice, exampleLines } from './fixtures/invoices/example'

const mocks = vi.hoisted(() => ({ stream: vi.fn(), save: vi.fn() }))
vi.mock('pdfmake/build/pdfmake', () => ({ default: { createPdf: () => ({ getStream: mocks.stream }) } }))
vi.mock('file-saver', () => ({ saveAs: mocks.save }))
const invoice = buildInvoiceDocument(exampleInvoice, exampleAccount, exampleLines, [], new Map())
const fetchMock = vi.fn()
let stream: EventEmitter & { end: ReturnType<typeof vi.fn>, destroy: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])))
  vi.stubGlobal('fetch', fetchMock)
  stream = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() })
  mocks.stream.mockReturnValue(stream)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('invoice download lifecycle', () => {
  it('downloads completed PDF bytes with the issued invoice number', async () => {
    vi.useFakeTimers()
    stream.end.mockImplementation(() => { stream.emit('data', new Uint8Array([37, 80, 68, 70])); stream.emit('end') })
    await downloadInvoicePdf(invoice, 'org_example')
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ type: 'application/pdf', size: 4 }), 'invoice-EXAMPLE1-00042.pdf')
    expect(mocks.save).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(stream.destroy).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects a font or layout failure instead of leaving the button pending', async () => {
    mocks.stream.mockImplementationOnce(() => { throw new Error('Invalid font bytes') })
    await expect(downloadInvoicePdf(invoice, 'org_example')).rejects.toThrow('Invalid font bytes')
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('rejects stream failures and clears the render timeout', async () => {
    vi.useFakeTimers()
    stream.end.mockImplementation(() => stream.emit('error', new Error('PDF stream failed')))
    await expect(downloadInvoicePdf(invoice, 'org_example')).rejects.toThrow('PDF stream failed')
    expect(vi.getTimerCount()).toBe(0)
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('times out a stalled renderer and never downloads a late result', async () => {
    vi.useFakeTimers()
    const result = downloadInvoicePdf(invoice, 'org_example').catch(error => error)
    await vi.waitFor(() => expect(stream.end).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await result).toMatchObject({ message: 'Invoice PDF rendering timed out' })
    expect(stream.destroy).toHaveBeenCalled()
    stream.emit('end')
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('does not render after the organization changes during asset loading', async () => {
    let valid = true
    fetchMock.mockImplementation(async () => { valid = false; return new Response(new Uint8Array([1])) })
    await downloadInvoicePdf(invoice, 'org_example', () => valid)
    expect(mocks.stream).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('does not download after the organization changes during rendering', async () => {
    let valid = true
    stream.end.mockImplementation(() => { valid = false; stream.emit('end') })
    await downloadInvoicePdf(invoice, 'org_example', () => valid)
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('reports failed asset requests without starting the renderer', async () => {
    fetchMock.mockResolvedValue(new Response('Unavailable', { status: 503 }))
    await expect(downloadInvoicePdf(invoice, 'org_example')).rejects.toThrow('Failed to load invoice asset')
    expect(mocks.stream).not.toHaveBeenCalled()
  })
})
