import { describe, expect, it } from 'vitest'

describe('manifest size receipts', () => {
  it.concurrent('binds an R2 path to its verified size and rejects tampering', async () => {
    const modulePath = '../supabase/functions/_backend/utils/manifest_size_receipt.ts'
    const receiptModule = await import(modulePath).catch(() => null)

    expect(receiptModule, 'manifest size receipt module must exist').not.toBeNull()
    if (!receiptModule)
      return

    const path = 'orgs/org/apps/com.app/delta/hash_index.html'
    const receipt = await receiptModule.createManifestSizeReceipt('secret', path, 321)

    expect(await receiptModule.verifyManifestSizeReceipts('secret', [{ path, receipt }])).toEqual([321])
    expect(await receiptModule.verifyManifestSizeReceipts('secret', [{ path: `${path}.changed`, receipt }])).toBeNull()
    expect(await receiptModule.verifyManifestSizeReceipts('wrong-secret', [{ path, receipt }])).toBeNull()
    expect(await receiptModule.verifyManifestSizeReceipts('secret', [{ path, receipt: `${receipt}x` }])).toBeNull()

    const secondPath = `${path}.map`
    const secondReceipt = await receiptModule.createManifestSizeReceipt('secret', secondPath, 654)
    expect(await receiptModule.verifyManifestSizeReceipts('secret', [
      { path, receipt },
      { path: secondPath, receipt: secondReceipt },
    ])).toEqual([321, 654])
    expect(await receiptModule.verifyManifestSizeReceipts('secret', [
      { path, receipt },
      { path: secondPath, receipt: `${secondReceipt}x` },
    ])).toBeNull()
  })
})
