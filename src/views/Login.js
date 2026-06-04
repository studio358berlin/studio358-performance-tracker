import { login } from '../lib/auth.js'
import { supabase } from '../lib/supabase.js'

export function Login({ onSuccess }) {
  function render() {
    const el = document.createElement('div')
    el.className = 'login-page'

    el.innerHTML = `
      <div class="login-card">
        <div class="login-logo">
          <img src="/images/studio358-logo.png" alt="Studio 358" style="max-width:180px;height:auto;margin-bottom:12px" />
          <p>Performance Tracker</p>
        </div>

        <div id="login-error" class="login-error" style="display:none"></div>
        <div id="login-success" style="display:none;font-size:0.875rem;padding:10px 14px;border-radius:6px;background:#e8f2e9;color:#3a6b3f;border:1px solid #6B8F71;margin-bottom:12px"></div>

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
            <div style="text-align:center;margin-top:8px">
              <button type="button" id="forgot-btn" style="background:none;border:none;padding:0;font-size:0.8rem;color:var(--aubergine);cursor:pointer;text-decoration:underline">
                [ Passwort vergessen? ]
              </button>
            </div>
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

    const form      = el.querySelector('#login-form')
    const errorEl   = el.querySelector('#login-error')
    const successEl = el.querySelector('#login-success')
    const btn       = el.querySelector('#login-btn')
    const forgotBtn = el.querySelector('#forgot-btn')

    form.addEventListener('submit', async e => {
      e.preventDefault()
      errorEl.style.display   = 'none'
      successEl.style.display = 'none'
      btn.disabled    = true
      btn.textContent = 'Anmelden…'

      const email    = el.querySelector('#email').value.trim()
      const password = el.querySelector('#password').value

      try {
        await login(email, password)
        await onSuccess?.()
      } catch (err) {
        errorEl.textContent = err.message === 'Invalid login credentials'
          ? 'E-Mail oder Passwort falsch.'
          : err.message
        errorEl.style.display = 'block'
        btn.disabled    = false
        btn.textContent = 'Anmelden'
      }
    })

    forgotBtn.addEventListener('click', async () => {
      errorEl.style.display   = 'none'
      successEl.style.display = 'none'

      const emailInput = el.querySelector('#email')
      const email      = emailInput.value.trim()

      if (!email) {
        errorEl.textContent    = 'Bitte zuerst die E-Mail-Adresse eingeben.'
        errorEl.style.display  = 'block'
        emailInput.focus()
        return
      }

      forgotBtn.disabled    = true
      forgotBtn.textContent = '[ Wird gesendet... ]'

      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + '/reset-password',
      })

      forgotBtn.disabled    = false
      forgotBtn.textContent = '[ Passwort vergessen? ]'

      if (error) {
        errorEl.textContent   = 'Fehler: ' + error.message
        errorEl.style.display = 'block'
        return
      }

      successEl.textContent    = 'Zuruecksetz-Link wurde an deine E-Mail gesendet!'
      successEl.style.display  = 'block'
    })

    return el
  }

  return { render }
}
