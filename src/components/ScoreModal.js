import { supabase } from '../lib/supabase.js'
import { getCriteriaForLevel } from '../lib/criteria.js'
import { calcWeightedScore } from '../lib/scoring.js'

export function ScoreModal({ employee, evaluatorId, onSaved, onClose }) {
  const criteria = getCriteriaForLevel(employee.level || 'junior')
  const scores = {}
  criteria.forEach(c => { scores[c.id] = 0 })

  function renderStars(criterionId, value) {
    return Array.from({ length: 5 }, (_, i) => `
      <span class="star ${i < value ? 'filled' : ''}"
        data-criterion="${criterionId}" data-value="${i + 1}"
        role="button" aria-label="${i + 1} Sterne">★</span>
    `).join('')
  }

  function render() {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'

    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <div>
            <h3>Bewertung</h3>
            <p style="color:var(--text-light);font-size:0.875rem;margin-top:4px">
              ${employee.full_name} · ${employee.level || 'Junior'}
            </p>
          </div>
          <button class="modal-close" id="modal-close-btn">✕</button>
        </div>

        <div class="criteria-list" id="criteria-container">
          ${criteria.map(c => `
            <div class="criterion-item">
              <div class="criterion-header">
                <span class="criterion-name">${c.label}</span>
                <span class="criterion-weight">${Math.round(c.weight * 100)}%</span>
              </div>
              <p style="font-size:0.75rem;color:var(--text-light);margin-bottom:6px">${c.description}</p>
              <div class="star-rating" data-criterion="${c.id}">
                ${renderStars(c.id, 0)}
              </div>
            </div>
          `).join('')}
        </div>

        <div style="margin-top:24px;padding-top:20px;border-top:1px solid var(--cream-dark)">
          <h4 style="margin-bottom:14px;font-size:0.95rem">Qualitätsdaten</h4>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label">Termine im Zeitraum</label>
              <input class="form-input" type="number" id="appointments-count"
                value="20" min="1" max="200" />
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label">Nachbesserungen / Reklamationen</label>
              <input class="form-input" type="number" id="reclamations-count"
                value="0" min="0" max="50" />
            </div>
          </div>
          <div class="form-group" style="margin-top:14px">
            <label class="form-label">Kundenfeedback (1–5)</label>
            <select class="form-select" id="customer-feedback">
              <option value="">– kein Feedback –</option>
              <option value="5">5 – Ausgezeichnet</option>
              <option value="4">4 – Sehr gut</option>
              <option value="3">3 – Gut</option>
              <option value="2">2 – Verbesserungsbedarf</option>
              <option value="1">1 – Schlecht</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Notizen (optional)</label>
            <textarea class="form-textarea" id="eval-notes"
              placeholder="Beobachtungen, Stärken, Entwicklungsbereiche…"></textarea>
          </div>
        </div>

        <div id="modal-error" class="login-error" style="display:none;margin-top:12px"></div>

        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:16px">
          <div id="score-preview" style="font-family:var(--font-heading);font-size:1.4rem;color:var(--aubergine)">
            Score: –
          </div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-ghost" id="cancel-btn">Abbrechen</button>
            <button class="btn btn-primary" id="save-btn">Bewertung speichern</button>
          </div>
        </div>
      </div>
    `

    overlay.querySelectorAll('.star').forEach(star => {
      star.addEventListener('click', () => {
        const criterion = star.dataset.criterion
        const value = Number(star.dataset.value)
        scores[criterion] = value
        updateStars(overlay, criterion, value)
        updatePreview(overlay)
      })
    })

    const close = () => { overlay.remove(); onClose?.() }
    overlay.querySelector('#modal-close-btn').addEventListener('click', close)
    overlay.querySelector('#cancel-btn').addEventListener('click', close)
    overlay.addEventListener('click', e => { if (e.target === overlay) close() })
    overlay.querySelector('#save-btn').addEventListener('click', () => save(overlay))

    return overlay
  }

  function updateStars(overlay, criterion, value) {
    overlay.querySelector(`.star-rating[data-criterion="${criterion}"]`)
      ?.querySelectorAll('.star')
      .forEach((s, i) => s.classList.toggle('filled', i < value))
  }

  function updatePreview(overlay) {
    const total = calcWeightedScore(scores, employee.level || 'junior')
    const el = overlay.querySelector('#score-preview')
    if (el) el.textContent = `Score: ${total.toFixed(1)} / 5.0`
  }

  async function save(overlay) {
    const saveBtn  = overlay.querySelector('#save-btn')
    const errorEl  = overlay.querySelector('#modal-error')

    const allScored = criteria.every(c => scores[c.id] > 0)
    if (!allScored) {
      errorEl.textContent = 'Bitte alle Kriterien bewerten.'
      errorEl.style.display = 'block'
      return
    }

    saveBtn.disabled = true
    saveBtn.textContent = 'Speichern…'
    errorEl.style.display = 'none'

    const score              = calcWeightedScore(scores, employee.level || 'junior')
    const complaints_count   = Number(overlay.querySelector('#reclamations-count')?.value ?? 0)
    const appointments_count = Number(overlay.querySelector('#appointments-count')?.value ?? 20)
    const feedback           = overlay.querySelector('#customer-feedback')?.value
    const notes              = overlay.querySelector('#eval-notes')?.value?.trim()

    const { error } = await supabase.from('performance_entries').insert({
      employee_id:       employee.id,
      evaluator_id:      evaluatorId,
      score,
      creativity:        scores.creativity   ?? 0,
      reliability:       scores.punctuality  ?? 0,
      productivity:      scores.revenue      ?? 0,
      appointments_count,
      complaints_count,
      customer_feedback: feedback ? Number(feedback) : null,
      notes:             notes || null,
    })

    if (error) {
      console.error('performance_entries INSERT fehlgeschlagen:', error)
      errorEl.textContent = 'Fehler: ' + error.message
      errorEl.style.display = 'block'
      saveBtn.disabled = false
      saveBtn.textContent = 'Bewertung speichern'
      return
    }

    overlay.remove()
    onSaved?.()
  }

  return { render }
}
