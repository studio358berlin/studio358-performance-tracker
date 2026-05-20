import { supabase } from '../lib/supabase.js'
import { getCriteriaForLevel } from '../lib/criteria.js'
import { calcWeightedScore } from '../lib/scoring.js'

export function ScoreModal({ employee, evaluatorId, isSelfAssessment = false, latestEval = null, isManager = false, onSaved, onClose }) {
  const criteria  = getCriteriaForLevel(employee.level || 'junior')
  const scores    = {}
  criteria.forEach(c => { scores[c.id] = 0 })

  const mgScores   = latestEval?.manager_scores ?? null
  const hasMgrEval = isSelfAssessment && mgScores != null && Object.keys(mgScores).length > 0

  const title     = isSelfAssessment ? 'Selbstbewertung' : 'Mitarbeiter bewerten'
  const saveLabel = isSelfAssessment ? 'Selbstbewertung speichern' : 'Manager-Bewertung speichern'

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
            <h3>${title}</h3>
            <p style="color:var(--text-light);font-size:0.875rem;margin-top:4px">
              ${employee.full_name} · ${employee.level || 'Junior'}
              ${isSelfAssessment ? ' · <em>Wie siehst du deine eigene Leistung?</em>' : ''}
            </p>
          </div>
          <button class="modal-close" id="modal-close-btn">✕</button>
        </div>

        <div class="criteria-list" id="criteria-container">
          ${isSelfAssessment && !hasMgrEval ? `
            <div style="padding:10px 14px;background:rgba(74,144,184,0.08);border-radius:var(--radius-sm);margin-bottom:16px;font-size:0.8rem;color:#4A90B8;border-left:3px solid #4A90B8">
              Du bewertest als Erster – danach kann der Manager seine Einschätzung ergänzen.
            </div>
          ` : ''}
          ${hasMgrEval ? `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--cream-dark)">
              <div style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#4A90B8">Meine Einschätzung</div>
              <div style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--aubergine)">Bewertung Management</div>
            </div>
          ` : ''}
          ${criteria.map(c => {
            const mgVal = hasMgrEval ? (mgScores[c.id] ?? null) : null
            return `
              <div class="criterion-item">
                <div class="criterion-header">
                  <span class="criterion-name">${c.label}</span>
                  <span class="criterion-weight">${Math.round(c.weight * 100)}%</span>
                </div>
                <p style="font-size:0.75rem;color:var(--text-light);margin-bottom:6px">${c.description}</p>
                <div style="${hasMgrEval ? 'display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:center' : ''}">
                  <div class="star-rating" data-criterion="${c.id}">
                    ${renderStars(c.id, 0)}
                  </div>
                  ${hasMgrEval ? `
                    <div style="display:flex;align-items:center;gap:6px">
                      <div style="flex:1;height:7px;background:rgba(61,43,53,0.1);border-radius:4px;overflow:hidden">
                        <div style="width:${mgVal != null ? (mgVal / 5) * 100 : 0}%;height:100%;background:var(--aubergine);border-radius:4px"></div>
                      </div>
                      <span style="font-size:0.75rem;font-weight:600;color:var(--aubergine);min-width:28px;text-align:right">
                        ${mgVal != null ? mgVal + '/5' : '–'}
                      </span>
                    </div>
                  ` : ''}
                </div>
              </div>
            `
          }).join('')}
        </div>

        ${!isSelfAssessment ? `
        <div style="margin-top:24px;padding-top:20px;border-top:1px solid var(--cream-dark)">
          <h4 style="margin-bottom:12px;font-size:0.95rem">Qualitätsdaten</h4>
          <div id="period-stats-card" style="margin-bottom:14px;padding:12px 14px;background:var(--cream);border-radius:var(--radius-sm)">
            <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-light);margin-bottom:8px">performance tracker</div>
            <div id="period-stats-body" style="font-size:0.85rem;color:var(--text-mid)">Lade Daten…</div>
          </div>
          <input type="hidden" id="appointments-count" value="20">
          <div class="form-group" style="margin-bottom:0">
            <label class="form-label">Nachbesserungen / Reklamationen</label>
            <input class="form-input" type="number" id="reclamations-count"
              value="0" min="0" max="50" />
          </div>
          <div class="form-group">
            <label class="form-label">Notizen (optional)</label>
            <textarea class="form-textarea" id="eval-notes"
              placeholder="Beobachtungen, Stärken, Entwicklungsbereiche…"></textarea>
          </div>
        </div>
        ` : `
        <div style="margin-top:16px;padding:12px 16px;background:var(--cream);border-radius:var(--radius-sm);font-size:0.8rem;color:var(--text-mid)">
          Deine Selbstbewertung wird mit der Manager-Bewertung kombiniert und beeinflusst deinen Performance Index.
        </div>
        `}

        <div id="modal-error" class="login-error" style="display:none;margin-top:12px"></div>

        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:16px">
          <div id="score-preview" style="font-family:var(--font-heading);font-size:1.4rem;color:var(--aubergine)">
            Score: –
          </div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-ghost" id="cancel-btn">Abbrechen</button>
            <button class="btn btn-primary" id="save-btn">${saveLabel}</button>
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

    if (!isSelfAssessment && latestEval?.employee_id && latestEval?.created_at) {
      loadPeriodStats(overlay, latestEval)
    } else if (!isSelfAssessment) {
      const body = overlay.querySelector('#period-stats-body')
      if (body) body.textContent = 'Kein Selbst-Assessment vorhanden.'
    }

    return overlay
  }

  async function loadPeriodStats(overlay, evaluation) {
    const { data, error } = await supabase.rpc('get_employee_evaluation_period_stats', {
      target_employee_id:    evaluation.employee_id,
      evaluation_created_at: evaluation.created_at,
    })

    const statsBody = overlay.querySelector('#period-stats-body')
    const appInput  = overlay.querySelector('#appointments-count')
    if (!statsBody) return

    if (error || !data) {
      statsBody.textContent = 'Statistik nicht verfügbar.'
      if (appInput) { appInput.readOnly = false; appInput.style.background = ''; appInput.style.cursor = '' }
      return
    }

    const row = Array.isArray(data) ? data[0] : data
    if (!row) {
      statsBody.textContent = 'Keine Daten im Zeitraum.'
      if (appInput) { appInput.readOnly = false; appInput.style.background = ''; appInput.style.cursor = '' }
      return
    }

    const appts   = Number(row.appointment_count ?? row.total_appointments ?? row.appointments ?? 0)
    const revenue = Number(row.total_revenue ?? row.revenue ?? 0)
    const tips    = Number(row.total_tips    ?? row.tips    ?? 0)
    const hours   = Number(row.hours_worked  ?? row.total_hours ?? 0)
    const avg     = appts > 0 ? revenue / appts : 0
    const fmtEur  = n => Number(n).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })

    const cols    = isManager ? 5 : 3
    const managerTiles = `
        <div>
          <div style="font-weight:700;color:var(--aubergine);font-size:0.95rem">${fmtEur(revenue)}</div>
          <div style="font-size:0.67rem;color:var(--text-light);margin-top:2px">Umsatz</div>
        </div>
        <div>
          <div style="font-weight:700;color:var(--aubergine);font-size:0.95rem">${fmtEur(avg)}</div>
          <div style="font-size:0.67rem;color:var(--text-light);margin-top:2px">Ø Kunde</div>
        </div>`

    statsBody.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;text-align:center">
        <div>
          <div style="font-weight:700;color:var(--aubergine);font-size:0.95rem">${appts}</div>
          <div style="font-size:0.67rem;color:var(--text-light);margin-top:2px">Bediente Kunden</div>
        </div>
        <div>
          <div style="font-weight:700;color:var(--gold);font-size:0.95rem">${fmtEur(tips)}</div>
          <div style="font-size:0.67rem;color:var(--text-light);margin-top:2px">Trinkgeld</div>
        </div>
        <div>
          <div style="font-weight:700;color:var(--aubergine);font-size:0.95rem">${Number(hours).toFixed(1)} Std.</div>
          <div style="font-size:0.67rem;color:var(--text-light);margin-top:2px">Arbeitszeit</div>
        </div>
        ${isManager ? managerTiles : ''}
      </div>
    `
    if (appInput) appInput.value = Math.max(1, appts)
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
    const saveBtn = overlay.querySelector('#save-btn')
    const errorEl = overlay.querySelector('#modal-error')

    const allScored = criteria.every(c => scores[c.id] > 0)
    if (!allScored) {
      errorEl.textContent = 'Bitte alle Kriterien bewerten.'
      errorEl.style.display = 'block'
      return
    }

    saveBtn.disabled = true
    saveBtn.textContent = 'Speichern…'
    errorEl.style.display = 'none'

    const score = calcWeightedScore(scores, employee.level || 'junior')

    let error, data

    if (isSelfAssessment) {
      // ── Attempt 1: SECURITY DEFINER RPC ──────────────────────────────────────
      const rpcArg = { p_self_scores: scores }
      console.log('Sending to DB (RPC submit_self_assessment):', rpcArg)
      ;({ data, error } = await supabase.rpc('submit_self_assessment', rpcArg))
      console.log('[ScoreModal] RPC result:', { data, error })

      // ── Attempt 2: direct upsert fallback if RPC is missing / broken ─────────
      if (error && latestEval?.id) {
        console.warn('[ScoreModal] RPC failed, trying upsert fallback:', error.message)
        const upsertPayload = {
          ...latestEval,
          self_scores:        scores,
          self_assessed_at:   new Date().toISOString(),
          is_self_assessment: true,
        }
        console.log('Sending to DB (upsert fallback):', upsertPayload)
        ;({ data, error } = await supabase
          .from('performance_entries')
          .upsert(upsertPayload, { onConflict: 'employee_id,evaluation_month' }))
        console.log('[ScoreModal] Upsert fallback result:', { data, error })
      }
    } else {
      // ── Manager evaluation — never touches self_scores or is_self_assessment ─────
      const reworks_count      = Number(overlay.querySelector('#reclamations-count')?.value ?? 0)
      const appointments_count = Number(overlay.querySelector('#appointments-count')?.value ?? 20)
      const feedback           = overlay.querySelector('#customer-feedback')?.value
      const notes              = overlay.querySelector('#eval-notes')?.value?.trim()

      const punctScore       = scores.punctuality ?? 3
      const punctuality_rate = punctScore >= 5 ? 1.0 : punctScore >= 4 ? 0.97 : punctScore >= 3 ? 0.90 : punctScore >= 2 ? 0.80 : 0.65

      const now = new Date()
      const evaluation_month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

      // ── Attempt 1: SECURITY DEFINER RPC (only writes manager fields) ─────────
      const rpcArgs = {
        p_employee_id:        employee.id,
        p_manager_scores:     scores,
        p_score:              score,
        p_appointments_count: appointments_count,
        p_reworks_count:      reworks_count,
        p_punctuality_rate:   punctuality_rate,
        p_customer_feedback:  feedback ? Number(feedback) : null,
        p_notes:              notes || null,
      }
      console.log('Sending to DB (RPC submit_manager_assessment):', rpcArgs)
      ;({ data, error } = await supabase.rpc('submit_manager_assessment', rpcArgs))
      console.log('[ScoreModal] Manager RPC result:', { data, error })

      // ── Attempt 2: targeted UPDATE fallback — still no is_self_assessment field ─
      if (error) {
        console.warn('[ScoreModal] Manager RPC failed, trying direct UPDATE fallback:', error.message)
        const updatePayload = {
          evaluator_id:        evaluatorId,
          manager_scores:      scores,
          manager_assessed_at: new Date().toISOString(),
          score,
          appointments_count,
          reworks_count,
          punctuality_rate,
          customer_feedback:   feedback ? Number(feedback) : null,
          notes:               notes || null,
        }
        console.log('Sending to DB (manager UPDATE fallback):', updatePayload)
        ;({ data, error } = await supabase
          .from('performance_entries')
          .update(updatePayload)
          .eq('employee_id', employee.id)
          .eq('evaluation_month', evaluation_month))
        console.log('[ScoreModal] Manager UPDATE result:', { data, error })
      }
    }

    if (error) {
      const msg = `Fehler beim Speichern:\n\n${error.message}\n\nCode: ${error.code ?? '–'}\nDetails: ${error.details ?? '–'}\nHint: ${error.hint ?? '–'}`
      console.error('[ScoreModal] Fehler:', error)
      window.alert(msg)
      errorEl.textContent = 'Fehler: ' + error.message
      errorEl.style.display = 'block'
      saveBtn.disabled = false
      saveBtn.textContent = saveLabel
      return
    }

    overlay.remove()
    onSaved?.()
  }

  return { render }
}
