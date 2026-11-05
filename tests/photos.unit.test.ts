import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const {
  getPhotoMock,
  pickImagesMock,
} = vi.hoisted(() => ({
  getPhotoMock: vi.fn(),
  pickImagesMock: vi.fn(),
}))

vi.mock('@capacitor/camera', () => ({
  Camera: {
    getPhoto: getPhotoMock,
    pickImages: pickImagesMock,
  },
  CameraResultType: {
    DataUrl: 'DataUrl',
  },
  CameraSource: {
    Camera: 'Camera',
  },
}))

vi.mock('@capacitor/filesystem', () => ({
  Filesystem: {
    readFile: vi.fn(),
  },
}))

vi.mock('~/services/console', () => ({
  useConsole: () => ({
    from: vi.fn(),
    storage: {
      from: vi.fn(),
    },
  }),
}))

vi.mock('~/stores/main', () => ({
  useMainStore: () => ({
    user: null,
  }),
}))

vi.mock('~/stores/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: null,
    fetchOrganizations: vi.fn(),
    setCurrentOrganization: vi.fn(),
  }),
}))

describe('photo helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('matches the PostHog photo cancellation errors', async () => {
    const { isPhotoSelectionCancelledError } = await import('~/services/photos.ts')

    expect(isPhotoSelectionCancelledError(new Error('User cancelled photos app'))).toBe(true)
    expect(isPhotoSelectionCancelledError({ message: 'User canceled image selection' })).toBe(true)
    expect(isPhotoSelectionCancelledError('The user cancelled image picking')).toBe(true)
    expect(isPhotoSelectionCancelledError(new Error('Camera permission denied'))).toBe(false)
  })

  it('swallows cancelled camera capture errors', async () => {
    getPhotoMock.mockRejectedValueOnce(new Error('User cancelled photos app'))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const isLoading = ref(false)
    const { takePhoto } = await import('~/services/photos.ts')

    await expect(takePhoto('update-account', isLoading, 'user', 'went-wrong')).resolves.toBeUndefined()

    expect(isLoading.value).toBe(false)
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('swallows cancelled image picker errors', async () => {
    pickImagesMock.mockRejectedValueOnce({ message: 'User canceled photos app' })
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const isLoading = ref(false)
    const { pickPhoto } = await import('~/services/photos.ts')

    await expect(pickPhoto('update-org', isLoading, 'org', 'went-wrong')).resolves.toBeUndefined()

    expect(isLoading.value).toBe(false)
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('still logs unexpected camera capture errors', async () => {
    getPhotoMock.mockRejectedValueOnce(new Error('Camera permission denied'))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const isLoading = ref(false)
    const { takePhoto } = await import('~/services/photos.ts')

    await expect(takePhoto('update-org', isLoading, 'org', 'went-wrong')).resolves.toBeUndefined()

    expect(isLoading.value).toBe(false)
    expect(consoleErrorSpy).toHaveBeenCalledOnce()
  })

  it('still logs unexpected image picker errors', async () => {
    pickImagesMock.mockRejectedValueOnce(new Error('Camera permission denied'))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const isLoading = ref(false)
    const { pickPhoto } = await import('~/services/photos.ts')

    await expect(pickPhoto('update-org', isLoading, 'org', 'went-wrong')).resolves.toBeUndefined()

    expect(isLoading.value).toBe(false)
    expect(consoleErrorSpy).toHaveBeenCalledOnce()
  })
})
