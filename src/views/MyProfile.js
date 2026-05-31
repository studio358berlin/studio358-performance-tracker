import { supabase } from '../lib/supabase.js'

export function MyProfile({ user }) {
  function render() {
    const wrap = document.createElement('div')
    wrap.className = 'main-content'

    wrap.innerHTML = `
      <div class="page-header">
        <h2>Mein Profil</h2>
        <p>Verwalte dein Passwort</p>
      </div>

      <div class="card" style="max-width:440px">
        <h4 style="margin-bottom:20px;color:var(--aubergine)">Passwort ändern</h4>

        <div class="form-group">
          <label class="form-label" for="new-password">Neues Passwort</label>
          <input id="new-password" type="password" class="form-input" placeholder="Mindestens 6 Zeichen" autocomplete="new-password" />
        </div>

        <div class="form-group">
          <label class="form-label" for="confirm-password">Neues Passwort bestätigen</label>
          <input id="confirm-password" type="password" class="form-input" placeholder="Passwort wiederholen" autocomplete="new-password" />
        </div>

        <div id="pw-message" style="display:none;margin-bottom:16px;font-size:0.875rem;padding:10px 14px;border-radius:var(--radius-sm)"></div>

        <button id="update-pw-btn" class="btn btn-primary" style="width:100%">
          [ Passwort aktualisieren ]
        </button>
      </div>
    `

    const pwInput      = wrap.querySelector('#new-password')
    const confirmInput = wrap.querySelector('#confirm-password')
    const msgEl        = wrap.querySelector('#pw-message')
    const btn          = wrap.querySelector('#update-pw-btn')

    function showMessage(text, isError) {
      msgEl.textContent = text
      msgEl.style.display = 'block'
      if (isError) {
        msgEl.style.background = '#fdecea'
        msgEl.style.color      = '#8b2e1a'
        msgEl.style.border     = '1px solid var(--terracotta)'
      } else {
        msgEl.style.background = '#e8f2e9'
        msgEl.style.color      = '#3a6b3f'
        msgEl.style.border     = '1px solid #6B8F71'
      }
    }

    function hideMessage() {
      msgEl.style.display = 'none'
      msgEl.textContent   = ''
    }

    btn.addEventListener('click', async () => {
      hideMessage()

      const newPassword     = pwInput.value
      const confirmPassword = confirmInput.value

      if (!newPassword || !confirmPassword) {
        showMessage('Bitte alle Felder ausfüllen.', true)
        return
      }
      if (newPassword !== confirmPassword) {
        showMessage('Die Passwörter stimmen nicht überein.', true)
        return
      }
      if (newPassword.length < 6) {
        showMessage('Das Passwort muss mindestens 6 Zeichen lang sein.', true)
        return
      }

      btn.disabled    = true
      btn.textContent = '[ Wird gespeichert... ]'

      const { error } = await supabase.auth.updateUser({ password: newPassword })

      btn.disabled    = false
      btn.textContent = '[ Passwort aktualisieren ]'

      if (error) {
        showMessage(error.message, true)
      } else {
        showMessage('Passwort erfolgreich aktualisiert.', false)
        pwInput.value      = ''
        confirmInput.value = ''
      }
    })

    return wrap
  }

  return { render }
}
