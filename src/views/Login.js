import { login } from '../lib/auth.js'

export function Login({ onSuccess }) {
  function render() {
    const el = document.createElement('div')
    el.className = 'login-page'

    el.innerHTML = `
      <div class="login-card">
        <div class="login-logo">
          <h1>Studio 358</h1>
          <p>Performance Tracker</p>
        </div>

        <div id="login-error" class="login-error" style="display:none"></div>

        <form id="login-form">
          <div class="form-group">
            <label class="form-label" for="email">E-Mail</label>
            <input
              class="form-input"
              type="email"
              id="email"
              placeholder="name@studio358.de"
              required
              autocomplete="email"
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="password">Passwort</label>
            <input
              class="form-input"
              type="password"
              id="password"
              placeholder="••••••••"
              required
              autocomplete="current-password"
            />
          </div>

          <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;margin-top:8px" id="login-btn">
            Anmelden
          </button>
        </form>

        <p style="text-align:center;margin-top:24px;font-size:0.75rem;color:var(--text-light)">
          Studio 358 · Berlin Mitte &amp; KaDeWe
        </p>
      </div>
    `

    const form = el.querySelector('#login-form')
    const errorEl = el.querySelector('#login-error')
    const btn = el.querySelector('#login-btn')

    form.addEventListener('submit', async e => {
      e.preventDefault()
      errorEl.style.display = 'none'
      btn.disabled = true
      btn.textContent = 'Anmelden…'

      const email = el.querySelector('#email').value.trim()
      const password = el.querySelector('#password').value

      try {
        await login(email, password)
        onSuccess?.()
      } catch (err) {
        errorEl.textContent = err.message === 'Invalid login credentials'
          ? 'E-Mail oder Passwort falsch.'
          : err.message
        errorEl.style.display = 'block'
        btn.disabled = false
        btn.textContent = 'Anmelden'
      }
    })

    return el
  }

  return { render }
}
