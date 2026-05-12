import { supabase } from '../lib/supabase.js'
import { ScoreModal } from '../components/ScoreModal.js'
import { TeamTable } from '../components/TeamTable.js'
import { LineChart } from '../components/LineChart.js'
import { getAllSkills, DEFAULT_SKILLS, checkPromotionEligibility } from '../lib/skills.js'
import { formatScore, getTrend, getTrendHTML, getLatestScore, calcQualityRate, calcTotalReclamations } from '../lib/scoring.js'
import { calculatePerformance, mapEntryToEngine, calcQPI } from '../lib/scoringEngine.js'

export function TeamManagement({ user }) {
  let employees      = []
  let evaluations    = []
  let activeLocation = 'all'
  let view           = 'list'
  let selectedEmployee = null
  let showAddForm    = false
  let container      = null

  async function loadData() {
    const [empRes, evalRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('role', 'employee').order('full_name'),
      supabase.from('performance_entries').select('*').order('created_at', { ascending: false }),
    ])
    employees   = empRes.data  ?? []
    evaluations = evalRes.data ?? []
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
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px">
          ${allSkills.map(skill => {
            const has = empSkills.includes(skill.id)
            return `
              <button
                class="btn btn-sm ${has ? 'btn-primary' : 'btn-ghost'} btn-toggle-skill"
                data-skill="${skill.id}" data-has="${has}" data-emp="${emp.id}"
                style="${has ? 'background:' + skill.color + ';border-color:' + skill.color : ''}"
              >
                ${skill.icon} ${skill.label} ${has ? '✓' : '+'}
              </button>
            `
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
    const evals       = getEvals(emp.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    const latestScore = getLatestScore(evals)
    const trend       = getTrend(evals)
    const qualityRate = calcQualityRate(evals)
    const totalRecs   = calcTotalReclamations(evals)
    const promotion   = checkPromotionEligibility(emp, evals)

    const piResult = evals[0] ? calculatePerformance(mapEntryToEngine(evals[0], emp.level)) : null
    const qpi      = calcQPI(evals, emp.level)

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

      <div class="stat-grid" style="grid-template-columns:repeat(5,1fr)">
        <div class="stat-card">
          <div class="stat-label">Score</div>
          <div class="stat-value">${latestScore !== null ? formatScore(latestScore) : '–'}</div>
          <div class="stat-sub">/ 5.0 · ${getTrendHTML(trend)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">PI Monat</div>
          <div class="stat-value" style="color:var(--aubergine)">${piResult ? piResult.PI_Monat : '–'}</div>
          <div class="stat-sub">von 100</div>
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
      </div>

      ${promotion.eligible ? `
        <div style="background:var(--success);color:#fff;border-radius:var(--radius-md);padding:14px 20px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between">
          <div>
            <strong>⬆ Promotion empfohlen</strong>
            <p style="font-size:0.8rem;opacity:0.9;margin-top:2px">Alle Kriterien für Senior-Status erfüllt.</p>
          </div>
          <button class="btn btn-sm" style="background:#fff;color:var(--success)" id="promote-btn" data-id="${emp.id}">Befördern</button>
        </div>
      ` : ''}

      ${buildSkillManager(emp)}

      <div class="card" style="margin-bottom:20px">
        <div class="card-header">
          <h4>Score-Verlauf</h4>
          <button class="btn btn-sm btn-accent" id="new-eval-btn" data-id="${emp.id}">+ Bewertung</button>
        </div>
        <div class="chart-container"><canvas id="team-detail-chart"></canvas></div>
      </div>

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
                    <td style="color:var(--text-mid)">${new Date(e.created_at).toLocaleDateString('de-DE')}</td>
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
        const evals = getEvals(selectedEmployee.id)
        LineChart('team-detail-chart', evals).render()
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

function locationLabel(loc) {
  return { mitte: 'Mitte', kadewe: 'KaDeWe' }[loc] ?? loc ?? '–'
}

function showToast(message, type = 'success') {
  let c = document.querySelector('.toast-container')
  if (!c) { c = document.createElement('div'); c.className = 'toast-container'; document.body.appendChild(c) }
  const t = document.createElement('div')
  t.className = `toast ${type}`; t.textContent = message
  c.appendChild(t); setTimeout(() => t.remove(), 3500)
}
