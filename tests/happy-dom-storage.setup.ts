import { GlobalWindow } from 'happy-dom'

// Node exposes localStorage, but it is undefined unless --localstorage-file is set.
// Vitest then skips copying happy-dom's storage onto the global.
if (typeof document !== 'undefined') {
  const storageWindow = new GlobalWindow({ url: 'http://localhost:3000' })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    get: () => storageWindow.localStorage,
  })
}
