let documentNavigationPending = false

export function isDocumentNavigationPending() {
  return documentNavigationPending
}

export function replaceDocument(url: string) {
  // Cancelled background imports must not interrupt the navigation with a reload.
  documentNavigationPending = true
  try {
    window.location.replace(url)
  }
  catch (error) {
    documentNavigationPending = false
    throw error
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', (event) => {
    // Initial pageshow can fire while the destination is still loading.
    if (event.persisted)
      documentNavigationPending = false
  })
}
