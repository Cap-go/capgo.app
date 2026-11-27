// Node exposes localStorage, but it is undefined unless --localstorage-file is set.
// Vitest then skips copying happy-dom's storage onto the global.
// Import happy-dom only in DOM files: this setup runs before all ~660 test files and a
// static import made every node-environment file pay for loading happy-dom.
if (typeof document !== 'undefined') {
  const { GlobalWindow } = await import('happy-dom')
  const storageWindow = new GlobalWindow({ url: 'http://localhost:3000' })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    get: () => storageWindow.localStorage,
  })
}
