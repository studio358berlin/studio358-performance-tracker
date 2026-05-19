import { supabase } from '../lib/supabase.js'
import { ScoreModal } from '../components/ScoreModal.js'
import { TeamTable } from '../components/TeamTable.js'
import { LineChart } from '../components/LineChart.js'
import { getAllSkills, DEFAULT_SKILLS, checkPromotionEligibility } from '../lib/skills.js'
import { formatScore, getTrend, getTrendHTML, getLatestScore, calcQualityRate, calcTotalReclamations, calcWeightedScore } from '../lib/scoring.js'
import { calculatePerformance, mapEntryToEngine, calcQPI } from '../lib/scoringEngine.js'
import { buildComparisonCard } from '../lib/buildComparisonCard.js'

export function TeamManagement({ user }) {
  let employees      = []
  let evaluations    = []
  let employeeHours  = []   // employee_daily_hours rows for current month
  let activeLocation = 'all'
  let view           = 'list'
  let selectedEmployee = null
  let showAddForm    = false
  let container      = null

  async function loadData() {
    const now             = new Date()
    const firstOfMonth    = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const firstOfMonthStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`

    const [empRes, evalRes, logsRes, hoursRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('role', 'employee').order('full_name'),
      supabase.from('performance_entries').select('*').order('created_at', { ascending: false }),
      supabase.from('daily_revenue_logs').select('employee_id, tip').gte('created_at', firstOfMonth),
      supabase.from('employee_daily_hours')
        .select('employee_id, date, hours_worked, break_minutes, location_id')
        .gte('date', firstOfMonthStr),
    ])
    employees   = empRes.data  ?? []
    evaluations = evalRes.data ?? []
    employeeHours = hoursRes.data ?? []

    // Aggregate monthly tips per employee from logs
    const tipsMap = {}
    for (const log of logsRes.data ?? []) {
      tipsMap[log.employee_id] = (tipsMap[log.employee_id] ?? 0) + Number(log.tip)
    }
    employees = employees.map(e => ({ ...e, total_tips_current_month: tipsMap[e.id] ?? 0 }))
  }

  function filteredEmployees() {
    if (activeLocation === 'all') return employees
    return employees.filter(e => e.location === activeLocation)
  }

  function getEvals(employeeId) {
    return evaluations.filter(e => e.employee_id === employeeId)
  }

  function showEvaluateModal(employeeId) {
    const emp = employees.find(e => e.id === employeeId)
    if (!emp) return
    const modal = ScoreModal({
      employee: emp, evaluatorId: user.id,
      onSaved: async () => {
        showToast('Bewertung gespeichert!', 'success')
        await loadData(); rerender()
      },
    })
    document.body.appendChild(modal.render())
  }

  // ── Skills ─────────────────────────────────────────────────────────────────

  function getAllKnownSkills() {
    const customIds = employees.flatMap(e => e.skills ?? [])
    return getAllSkills(customIds)
  }

  async function toggleSkill(employeeId, skillId, hasSkill) {
    const emp = employees.find(e => e.id === employeeId)
    if (!emp) return

    const current = emp.skills ?? []
    const updated = hasSkill
      ? current.filter(s => s !== skillId)
      : [...new Set([...current, skillId])]

    const { error } = await supabase
      .from('profiles').update({ skills: updated }).eq('id', employeeId)

    if (error) { showToast('Fehler: ' + error.message, 'error'); return }

    emp.skills = updated
    if (selectedEmployee?.id === employeeId) selectedEmployee = { ...emp }
    rerender()
  }

  async function addCustomSkill(employeeId, skillLabel) {
    const skillId = skillLabel.toLowerCase().replace(/\s+/g, '_')
    await toggleSkill(employeeId, skillId, false)
  }

  // ── Employee form ──────────────────────────────────────────────────────────

  async function deleteEmployee(employeeId) {
    const { error } = await supabase.rpc('delete_employee', { employee_id: employeeId })
    if (error) throw error
  }

  async function handleDelete(employeeId) {
    try {
      await deleteEmployee(employeeId)
      showToast('Mitarbeiter gelöscht.', 'success')
      await loadData()
      rerender()
    } catch (err) {
      console.error('deleteEmployee fehlgeschlagen:', err)
      showToast('Fehler beim Löschen: ' + err.message, 'error')
    }
  }

  async function addEmployee(formData) {
    const tempPassword = formData.password || Math.random().toString(36).slice(-8)

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email:    formData.email,
      password: tempPassword,
      options: {
        data: { full_name: formData.full_name, role: 'employee' },
      },
    })
    if (authError) {
      console.error('auth.signUp fehlgeschlagen:', authError)
      throw authError
    }

    const { error: profileError } = await supabase.from('profiles').insert({
      id:        authData.user.id,
      full_name: formData.full_name,
      email:     formData.email,
      role:      'employee',
      location:  formData.location,
      level:     formData.level || 'junior',
    })
    if (profileError) {
      console.error('profiles INSERT fehlgeschlagen:', profileError)
      throw profileError
    }
  }

  // ── HTML builders ──────────────────────────────────────────────────────────

  function buildSkillManager(emp) {
    const allSkills = getAllKnownSkills()
    const empSkills = emp.skills ?? []

    return `
      <div class="card" style="margin-bottom:20px">
        <div class="card-header">
          <h4>Skills verwalten</h4>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;align-items:center">
          ${allSkills.map(skill => {
            const has = empSkills.includes(skill.id)
            return `<button
              class="btn-toggle-skill"
              data-skill="${skill.id}" data-has="${has}" data-emp="${emp.id}"
              style="font-size:0.62rem;padding:2px 7px;line-height:1.6;background:${has ? skill.color : 'var(--cream-dark)'};color:${has ? '#fff' : 'var(--text-mid)'};${has ? '' : 'opacity:0.75;'}border:none;border-radius:20px;cursor:pointer"
              title="${has ? 'Klicken zum Entfernen' : 'Klicken zum Hinzufügen'}"
            >${skill.icon ? skill.icon + ' ' : ''}${skill.label}${has ? ' ✓' : ' +'}</button>`
          }).join('')}
        </div>
        <div style="display:flex;gap:8px">
          <input class="form-input" id="custom-skill-input" placeholder="Neuer Skill (z.B. Airbrush)" style="flex:1" />
          <button class="btn btn-ghost btn-sm" id="add-custom-skill" data-emp="${emp.id}">Hinzufügen</button>
        </div>
      </div>
    `
  }

  function buildDetailView(emp) {
    const allEvals    = getEvals(emp.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    // Prefer the most recent row with a self-assessment for the comparison card
    const comparisonRow = allEvals.find(e => e.self_scores && Object.keys(e.self_scores).length > 0) ?? allEvals[0]
    console.log('Manager View Data:', { employee: emp.full_name, comparisonRow, self_scores: comparisonRow?.self_scores, manager_scores: comparisonRow?.manager_scores })
    // Only manager-scored entries count for PI, QPI, chart, history stats
    const evals       = allEvals.filter(e => e.manager_scores && Object.keys(e.manager_scores).length > 0)
    const latestScore = getLatestScore(evals)
    const trend       = getTrend(evals)
    const qualityRate = calcQualityRate(evals)
    const totalRecs   = calcTotalReclamations(evals)
    const promotion   = checkPromotionEligibility(emp, evals)

    const piResult = evals[0] ? calculatePerformance(mapEntryToEngine(evals[0], emp.level, emp)) : null
    const qpi      = calcQPI(evals, emp.level)

    const mgrScores0    = evals[0]?.manager_scores ?? {}
    const selfScores0   = evals[0]?.self_scores ?? null
    const combinedScore = evals[0]
      ? (() => {
          const mgrW  = calcWeightedScore(mgrScores0, emp.level)
          const selfW = selfScores0 ? calcWeightedScore(selfScores0, emp.level) : mgrW
          return Math.round((0.75 * mgrW + 0.25 * selfW) * 10) / 10
        })()
      : null

    const avgOf   = s => { if (!s) return null; const v = Object.values(s).filter(x => x > 0); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null }
    const mgAvg   = avgOf(Object.keys(mgrScores0).length ? mgrScores0 : null)
    const selfAvg = avgOf(selfScores0)

    const bonusBadgeColor = { Gold: 'var(--gold)', Silber: '#A0A0A0', Bronze: 'var(--terracotta)' }

    return `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
        <button class="btn btn-ghost btn-sm" id="back-to-list">← Zurück</button>
        <h3 style="color:var(--aubergine)">${emp.full_name}</h3>
        <span class="badge ${emp.level === 'senior' ? 'badge-aubergine' : 'badge-gold'}">${emp.level}</span>
        <span class="badge badge-neutral">${locationLabel(emp.location)}</span>
        ${promotion.eligible ? `<span class="badge badge-success">⬆ Promotion-Ready</span>` : ''}
        ${piResult?.vetoAusgeloest ? `<span class="badge" style="background:var(--terracotta);color:#fff">⚠ Safety Veto</span>` : ''}
      </div>

      <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
        <div class="stat-card">
          <div class="stat-label">Score</div>
          <div class="stat-value">${combinedScore !== null ? formatScore(combinedScore) : '–'}</div>
          <div class="stat-sub">/ 5.0${selfScores0 ? ' · 75/25' : ''} · ${getTrendHTML(trend)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">PI Monat</div>
          <div class="stat-value" style="color:${piResult?.vetoAusgeloest ? 'var(--terracotta)' : 'var(--aubergine)'}">${piResult ? piResult.PI_Monat : 'Ausstehend'}</div>
          <div class="stat-sub">von 100${piResult?.vetoAusgeloest ? ' · ⚠ Veto' : piResult ? '' : ' · keine Daten'}</div>
          ${piResult?.vetoAusgeloest && piResult.vetoCauses?.length ? `
            <div style="font-size:0.62rem;color:var(--terracotta);margin-top:2px;line-height:1.4">Veto: ${piResult.vetoCauses.join(' · ')}</div>
          ` : ''}
        </div>
        <div class="stat-card">
          <div class="stat-label">QPI Quartal</div>
          <div class="stat-value" style="color:var(--aubergine)">${qpi !== null ? qpi : '–'}</div>
          <div class="stat-sub">${qpi === null ? '< 3 Bewertungen' : 'Ø 3 Monate'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Bonusstufe</div>
          <div class="stat-value" style="font-size:1.2rem;color:${bonusBadgeColor[piResult?.bonusStufe] ?? 'var(--text-light)'}">
            ${piResult?.bonusStufe ?? '–'}
          </div>
          <div class="stat-sub">aktuell</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Quality Rate</div>
          <div class="stat-value" style="color:${qualityRate !== null && qualityRate >= 95 ? 'var(--success)' : 'var(--terracotta)'}">
            ${qualityRate !== null ? qualityRate + '%' : '–'}
          </div>
          <div class="stat-sub">Kundenzufriedenheit</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Umsatz Monat</div>
          <div class="stat-value" style="font-size:1.3rem">
            ${emp.total_revenue_current_month > 0 ? '€ ' + Number(emp.total_revenue_current_month).toFixed(0) : '–'}
          </div>
          <div class="stat-sub">Phase 4 · Quick-Tap</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Behandlungen</div>
          <div class="stat-value" style="font-size:1.5rem">
            ${emp.treatments_count_current_month > 0 ? emp.treatments_count_current_month : '–'}
          </div>
          <div class="stat-sub">aktueller Monat</div>
        </div>
      </div>

      <details open style="margin-bottom:16px">
        <summary style="font-size:0.72rem;font-weight:600;color:var(--text-light);cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;padding:2px 0">
          ◉ Debug · Berechnungsdetails
        </summary>
        <div style="font-size:0.72rem;background:rgba(61,43,53,0.05);border-radius:var(--radius-sm);padding:10px 14px;margin-top:6px;display:flex;flex-wrap:wrap;gap:6px 20px;line-height:2;font-family:monospace">
          <span>Manager-Schnitt:&nbsp;<strong>${mgAvg ?? '–'}&thinsp;/5</strong></span>
          <span>Mitarbeiter-Schnitt:&nbsp;<strong>${selfAvg ?? '–'}&thinsp;/5</strong></span>
          <span>Veto aktiv:&nbsp;<strong style="color:${piResult?.vetoAusgeloest ? 'var(--terracotta)' : '#6B8F71'}">${piResult?.vetoAusgeloest ? 'JA ⚠' : piResult ? 'Nein ✓' : '–'}</strong></span>
          ${piResult?.vetoCauses?.length ? `<span style="color:var(--terracotta)">Durch:&nbsp;${piResult.vetoCauses.join(' · ')}</span>` : ''}
          <span>Berechneter PI:&nbsp;<strong style="color:var(--aubergine)">${piResult ? piResult.PI_Monat : 'null'}</strong></span>
          <span style="color:var(--text-light)">Szenario:&nbsp;<strong>${!piResult ? 'C – keine Daten' : piResult.vetoAusgeloest ? 'A – Veto' : piResult.PI_Monat === 0 ? 'B – Formel?' : '✓ OK'}</strong></span>
        </div>
      </details>

      ${promotion.eligible ? `
        <div style="background:var(--success);color:#fff;border-radius:var(--radius-md);padding:14px 20px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between">
          <div>
            <strong>⬆ Promotion empfohlen</strong>
            <p style="font-size:0.8rem;opacity:0.9;margin-top:2px">Alle Kriterien für Senior-Status erfüllt.</p>
          </div>
          <button class="btn btn-sm" style="background:#fff;color:var(--success)" id="promote-btn" data-id="${emp.id}">Befördern</button>
        </div>
      ` : ''}

      <div class="card" style="margin-bottom:20px">
        <div class="card-header">
          <h4>PI-Verlauf</h4>
          <button class="btn btn-sm btn-accent" id="new-eval-btn" data-id="${emp.id}">+ Bewertung</button>
        </div>
        <div class="chart-container"><canvas id="team-detail-chart"></canvas></div>
      </div>

      ${comparisonRow ? buildComparisonCard(comparisonRow, emp.level, {
          selfLabel:    'Selbsteinschätzung (Mitarbeiter)',
          managerLabel: 'Meine Bewertung (Management)',
        }) : ''}

      ${buildSkillManager(emp)}

      <div class="card">
        <h4 style="margin-bottom:16px">Bewertungsverlauf</h4>
        ${evals.length ? `
          <div class="table-wrapper">
            <table>
              <thead>
                <tr><th>Datum</th><th>Score</th><th>Reklamationen</th><th>Notizen</th></tr>
              </thead>
              <tbody>
                ${evals.map(e => `
                  <tr>
                    <td style="color:var(--text-mid)">${e.evaluation_month ? new Date(e.evaluation_month + 'T12:00:00').toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }) : new Date(e.created_at).toLocaleDateString('de-DE')}</td>
                    <td style="font-weight:600;color:var(--aubergine)">${formatScore(e.score)}</td>
                    <td style="color:${(e.reworks_count ?? e.complaints_count ?? 0) > 0 ? 'var(--terracotta)' : 'var(--text-light)'}">
                      ${e.reworks_count ?? e.complaints_count ?? 0}
                    </td>
                    <td style="color:var(--text-light);font-size:0.8rem">${e.notes || '–'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `<div class="empty-state"><span class="empty-state-icon">◉</span><p>Noch keine Bewertungen.</p></div>`}
      </div>
    `
  }

  function buildAddForm() {
    return `
      <div class="card" style="margin-bottom:24px">
        <div class="card-header">
          <h4>Neuen Mitarbeiter anlegen</h4>
          <button class="btn btn-ghost btn-sm" id="cancel-add">Abbrechen</button>
        </div>
        <div id="add-error" class="login-error" style="display:none"></div>
        <form id="add-employee-form">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
            <div class="form-group">
              <label class="form-label">Vollständiger Name</label>
              <input class="form-input" name="full_name" placeholder="Sophie Müller" required />
            </div>
            <div class="form-group">
              <label class="form-label">E-Mail</label>
              <input class="form-input" type="email" name="email" placeholder="sophie@studio358.de" required />
            </div>
            <div class="form-group">
              <label class="form-label">Initiales Passwort</label>
              <input class="form-input" type="password" name="password" placeholder="Mindestens 8 Zeichen" minlength="8" />
            </div>
            <div class="form-group">
              <label class="form-label">Location</label>
              <select class="form-select" name="location" required>
                <option value="">– wählen –</option>
                <option value="mitte">Berlin Mitte</option>
                <option value="kadewe">KaDeWe</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Level</label>
              <select class="form-select" name="level">
                <option value="junior">Junior</option>
                <option value="senior">Senior</option>
              </select>
            </div>
          </div>
          <button type="submit" class="btn btn-primary" id="add-submit-btn">Mitarbeiter anlegen</button>
        </form>
      </div>
    `
  }

  function openAdminHoursModal(empId) {
    const today    = localDate()
    const emp      = employees.find(e => e.id === empId)
    const existing = employeeHours.find(h => h.employee_id === empId && h.date === today)

    const overlay = document.createElement('div')
    overlay.style.position        = 'fixed'
    overlay.style.top             = '0'
    overlay.style.left            = '0'
    overlay.style.width           = '100vw'
    overlay.style.height          = '100vh'
    overlay.style.zIndex          = '9999'
    overlay.style.display         = 'flex'
    overlay.style.alignItems      = 'center'
    overlay.style.justifyContent  = 'center'
    overlay.style.background      = 'rgba(0,0,0,0.55)'
    overlay.style.padding         = '16px'
    overlay.style.boxSizing       = 'border-box'

    const curHours = Number(existing?.hours_worked) || 8
    const curBreak = Number(existing?.break_minutes) || 0

    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:360px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:18px 20px 0">
          <div>
            <h3 style="margin:0;font-size:1.05rem;color:var(--aubergine)">Stundenkorrektur</h3>
            <div style="font-size:0.78rem;color:var(--text-light);margin-top:2px">${emp?.full_name ?? '–'} · ${today}</div>
          </div>
          <button id="ah-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-light);line-height:1;padding:4px">✕</button>
        </div>
        <div style="padding:16px 20px;display:flex;flex-direction:column;gap:14px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Arbeitszeit (Stunden)
            <input id="ah-hours" type="number" min="0" max="24" step="0.5" value="${curHours}"
              style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:1.1rem;font-weight:600;text-align:center">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Pause (Minuten)
            <input id="ah-break" type="number" min="0" max="180" step="5" value="${curBreak}"
              style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:1.1rem;font-weight:600;text-align:center">
          </label>
          <div style="background:var(--cream-dark);border-radius:var(--radius-sm);padding:10px 14px;text-align:center;font-size:0.85rem;color:var(--text-mid)">
            Netto: <strong id="ah-net" style="color:var(--aubergine)">– Std.</strong>
          </div>
        </div>
        <div style="padding:0 20px 20px">
          <button id="ah-save" class="btn btn-accent" style="width:100%;justify-content:center">Speichern</button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    const hoursInput = overlay.querySelector('#ah-hours')
    const breakInput = overlay.querySelector('#ah-break')
    const netDisplay = overlay.querySelector('#ah-net')

    function updateNet() {
      const h = Math.max(0, parseFloat(hoursInput.value) || 0)
      const b = Math.max(0, parseFloat(breakInput.value) || 0)
      netDisplay.textContent = Math.max(0, h - b / 60).toFixed(1) + ' Std.'
    }
    updateNet()
    hoursInput.addEventListener('input', updateNet)
    breakInput.addEventListener('input', updateNet)

    overlay.querySelector('#ah-close').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

    overlay.querySelector('#ah-save').addEventListener('click', async () => {
      const h = Math.max(0, parseFloat(hoursInput.value) || 0)
      const b = Math.max(0, parseInt(breakInput.value, 10) || 0)
      const saveBtn = overlay.querySelector('#ah-save')
      saveBtn.disabled = true; saveBtn.textContent = 'Speichern...'

      let upsertError = null
      try {
        const r1 = await supabase
          .from('employee_daily_hours')
          .upsert({
            employee_id:   empId,
            date:          today,
            hours_worked:  h,
            break_minutes: b,
            location_id:   emp?.location_id ?? null,
          }, { onConflict: 'employee_id,date' })
        upsertError = r1.error
      } catch (err) {
        showToast('Fehler: ' + (err?.message || 'Unbekannter Fehler'), 'error')
        saveBtn.disabled = false; saveBtn.textContent = 'Speichern'
        return
      }

      if (upsertError) {
        showToast('Fehler: ' + upsertError.message, 'error')
        saveBtn.disabled = false; saveBtn.textContent = 'Speichern'
        return
      }
      showToast(`Stunden für ${emp?.full_name ?? '–'} aktualisiert.`)
      overlay.remove()
      await loadData()
      rerender()
    })
  }

  function buildHoursTable() {
    const today     = localDate()
    const weekStart = (() => {
      const d = new Date(); const day = d.getDay() || 7
      d.setDate(d.getDate() - (day - 1))
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    })()

    const rows = employees.map(emp => {
      const empH = employeeHours.filter(h => h.employee_id === emp.id)
      const netMins = (filter) => empH.filter(filter).reduce((s, h) => s + Math.max(0, h.hours_worked * 60 - h.break_minutes), 0)
      return {
        emp,
        todayMins: netMins(h => h.date === today),
        weekMins:  netMins(h => h.date >= weekStart),
        monthMins: netMins(() => true),
      }
    })

    return `
      <div class="card" style="margin-bottom:24px">
        <div class="card-header">
          <h4>Arbeitszeiten-Konto (Übersicht)</h4>
          <span style="font-size:0.78rem;color:var(--text-light)">Netto-Stunden (ohne Pausen)</span>
        </div>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Mitarbeiter</th>
                <th>Heute</th>
                <th>Diese Woche</th>
                <th>Diesen Monat</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(({ emp, todayMins, weekMins, monthMins }) => `
                <tr class="hours-row" data-emp="${emp.id}" style="cursor:pointer" title="Klicken zum Bearbeiten">
                  <td>
                    <div style="font-weight:500">${emp.full_name}</div>
                    <div style="font-size:0.72rem;color:var(--text-light)">${locationLabel(emp.location)}</div>
                  </td>
                  <td style="font-weight:600;color:var(--aubergine)">${fmtHours(todayMins)}</td>
                  <td>${fmtHours(weekMins)}</td>
                  <td style="font-weight:600;color:var(--aubergine)">${fmtHours(monthMins)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `
  }

  function buildListHTML() {
    return `
      <div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <h2>Team Management</h2>
          <p style="color:var(--text-light);font-size:0.875rem">Mitarbeiter verwalten, Skills zuweisen, Bewertungen erfassen</p>
        </div>
        <button class="btn btn-accent" id="add-employee-btn">+ Mitarbeiter</button>
      </div>

      ${showAddForm ? buildAddForm() : ''}

      <div class="location-tabs">
        <button class="location-tab ${activeLocation === 'all'    ? 'active' : ''}" data-loc="all">Alle</button>
        <button class="location-tab ${activeLocation === 'mitte'  ? 'active' : ''}" data-loc="mitte">Mitte</button>
        <button class="location-tab ${activeLocation === 'kadewe' ? 'active' : ''}" data-loc="kadewe">KaDeWe</button>
      </div>

      ${buildHoursTable()}

      <div class="card">
        <div id="team-table-area"></div>
      </div>
    `
  }

  function buildHTML() {
    return view === 'detail' && selectedEmployee
      ? buildDetailView(selectedEmployee)
      : buildListHTML()
  }

  function attachDetailEvents() {
    container.querySelector('#back-to-list')?.addEventListener('click', () => {
      selectedEmployee = null; view = 'list'; rerender()
    })

    container.querySelector('#new-eval-btn')?.addEventListener('click', e => {
      showEvaluateModal(e.currentTarget.dataset.id)
    })

    container.querySelector('#promote-btn')?.addEventListener('click', async e => {
      const id = e.currentTarget.dataset.id
      if (!confirm('Mitarbeiter zum Senior befördern?')) return
      const { error } = await supabase.from('profiles').update({ level: 'senior' }).eq('id', id)
      if (error) { showToast('Fehler: ' + error.message, 'error'); return }
      showToast('Beförderung erfolgreich!', 'success')
      await loadData()
      selectedEmployee = employees.find(emp => emp.id === id) ?? null
      rerender()
    })

    container.querySelectorAll('.btn-toggle-skill').forEach(btn => {
      btn.addEventListener('click', () => {
        toggleSkill(btn.dataset.emp, btn.dataset.skill, btn.dataset.has === 'true')
          .then(() => loadData()).then(() => rerender())
      })
    })

    container.querySelector('#add-custom-skill')?.addEventListener('click', async e => {
      const input = container.querySelector('#custom-skill-input')
      const val   = input?.value?.trim()
      if (!val) return
      await addCustomSkill(e.currentTarget.dataset.emp, val)
      await loadData()
      rerender()
    })

    setTimeout(() => {
      if (selectedEmployee) {
        const evals  = getEvals(selectedEmployee.id)
          .filter(e => e.manager_scores && Object.keys(e.manager_scores).length > 0)
        const level  = selectedEmployee.level || 'junior'
        const sorted = [...evals].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        const labels = sorted.map(e => e.evaluation_month
          ? new Date(e.evaluation_month + 'T12:00:00').toLocaleDateString('de-DE', { month: 'short', year: '2-digit' })
          : new Date(e.created_at).toLocaleDateString('de-DE', { month: 'short', year: '2-digit' }))
        const values = sorted.map(e => calculatePerformance(mapEntryToEngine(e, level)).PI_Monat)
        LineChart('team-detail-chart', { labels, values }).render()
      }
    }, 0)
  }

  function attachListEvents() {
    container.querySelector('#add-employee-btn')?.addEventListener('click', () => {
      showAddForm = true; rerender()
    })

    container.querySelector('#cancel-add')?.addEventListener('click', () => {
      showAddForm = false; rerender()
    })

    container.querySelectorAll('.location-tab[data-loc]').forEach(tab => {
      tab.addEventListener('click', () => { activeLocation = tab.dataset.loc; rerender() })
    })

    container.querySelector('#add-employee-form')?.addEventListener('submit', async e => {
      e.preventDefault()
      const btn     = container.querySelector('#add-submit-btn')
      const errorEl = container.querySelector('#add-error')
      btn.disabled  = true; btn.textContent = 'Anlegen…'
      errorEl.style.display = 'none'
      try {
        await addEmployee(Object.fromEntries(new FormData(e.target)))
        showToast('Mitarbeiter angelegt!', 'success')
        showAddForm = false
        await loadData(); rerender()
      } catch (err) {
        errorEl.textContent = 'Fehler: ' + err.message
        errorEl.style.display = 'block'
        btn.disabled = false; btn.textContent = 'Mitarbeiter anlegen'
      }
    })

    container.querySelectorAll('.hours-row[data-emp]').forEach(row => {
      row.addEventListener('pointerenter', () => { row.style.background = 'var(--cream)' })
      row.addEventListener('pointerleave', () => { row.style.background = '' })
      row.addEventListener('click', () => openAdminHoursModal(row.dataset.emp))
    })

    const tableArea = container.querySelector('#team-table-area')
    if (tableArea) {
      const table = TeamTable({
        employees: filteredEmployees(),
        evaluations,
        onEvaluate: showEvaluateModal,
        onViewDetail: id => {
          selectedEmployee = employees.find(e => e.id === id) ?? null
          view = 'detail'; rerender()
        },
        onDelete: handleDelete,
      })
      tableArea.appendChild(table.render())
    }
  }

  function rerender() {
    if (!container) return
    container.innerHTML = buildHTML()
    view === 'detail' ? attachDetailEvents() : attachListEvents()
  }

  async function render() {
    const el = document.createElement('div')
    el.className = 'main-content'
    el.innerHTML = '<div class="loader"><div class="spinner"></div></div>'
    container = el

    await loadData()
    el.innerHTML = buildHTML()
    attachListEvents()

    return el
  }

  return { render }
}

function localDate() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function locationLabel(loc) {
  return { mitte: 'Mitte', kadewe: 'KaDeWe' }[loc] ?? loc ?? '–'
}

function fmtHours(mins) {
  if (!mins) return '<span style="color:var(--text-light)">–</span>'
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return m > 0 ? `${h}:${String(m).padStart(2, '0')} Std.` : `${h} Std.`
}

function showToast(message, type = 'success') {
  let c = document.querySelector('.toast-container')
  if (!c) { c = document.createElement('div'); c.className = 'toast-container'; document.body.appendChild(c) }
  const t = document.createElement('div')
  t.className = `toast ${type}`; t.textContent = message
  c.appendChild(t); setTimeout(() => t.remove(), 3500)
}
