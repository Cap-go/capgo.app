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

  mediaQuery.addEventListener('change', function (event) {
    const currentSavedTheme = localStorage.getItem('theme')
    if (!currentSavedTheme || currentSavedTheme === 'auto') {
      applyTheme(event.matches)
    }
  })

  window.__setTheme = function (theme) {
    if (theme === 'auto') {
      localStorage.setItem('theme', 'auto')
      applyTheme(mediaQuery.matches)
    }
    else {
      localStorage.setItem('theme', theme)
      applyTheme(theme === 'dark')
    }
  }
})()
