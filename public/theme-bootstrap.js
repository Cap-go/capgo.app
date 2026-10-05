// Initialize theme before Vue app loads to prevent flash
(function () {
  function applyTheme(isDark) {
    const html = document.documentElement
    if (isDark) {
      html.classList.add('dark')
      html.dataset.theme = 'capgodark'
    }
    else {
      html.classList.remove('dark')
      html.dataset.theme = 'capgolight'
    }
  }

  const savedTheme = localStorage.getItem('theme')
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

  let isDark
  if (savedTheme === 'dark') {
    isDark = true
  }
  else if (savedTheme === 'light') {
    isDark = false
  }
  else {
    isDark = mediaQuery.matches
  }

  applyTheme(isDark)

  function onSystemThemeChange(event) {
    const currentSavedTheme = localStorage.getItem('theme')
    if (!currentSavedTheme || currentSavedTheme === 'auto') {
      applyTheme(event.matches)
    }
  }

  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', onSystemThemeChange)
  }
  else if (typeof mediaQuery.addListener === 'function') {
    mediaQuery.addListener(onSystemThemeChange)
  }
})()
