import { supabase } from '../lib/supabase.js'
import { TeamTable } from '../components/TeamTable.js'
import { ScoreModal } from '../components/ScoreModal.js'
import { LineChart } from '../components/LineChart.js'
import { checkPromotionEligibility } from '../lib/skills.js'
import {
  formatScore, getLatestScore, getTrend, getTrendHTML,
  calcQualityRate, calcTotalReclamations, calcWeightedScore,
} from '../lib/scoring.js'
import { calculatePerformance, mapEntryToEngine, calcQPI } from '../lib/scoringEngine.js'
import { buildComparisonCard } from '../lib/buildComparisonCard.js'

export function Dashboard({ user }) {
  let employees   = []
  let evaluations = []
  let activeLocation = 'all'
  let selectedEmployee = null
  let container = null

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

  function getStats() {
    const list   = filteredEmployees()
    const scores = list.map(e => getLatestScore(getEvals(e.id))).filter(s => s !== null)
    const avg    = scores.length
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10
      : null

    const totalRecs = evaluations
      .filter(e => list.some(emp => emp.id === e.employee_id))
      .reduce((s, e) => s + (e.complaints_count ?? 0), 0)

    const promotionReady = list.filter(emp => {
      if (emp.level !== 'junior') return false
      return checkPromotionEligibility(emp, getEvals(emp.id)).eligible
    }).length

    return {
      total:           list.length,
      avg,
      excellent:       scores.filter(s => s >= 4).length,
      needsAttention:  scores.filter(s => s < 3).length,
      evaluated:       scores.length,
      totalRecs,
      promotionReady,
    }
  }

  function showEvaluateModal(employeeId) {
    const emp = employees.find(e => e.id === employeeId)
    if (!emp) return
    const latestSelfEval = evaluations
      .filter(e => e.employee_id === employeeId && e.is_self_assessment === true)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] ?? null

    const modal = ScoreModal({
      employee:    emp,
      evaluatorId: user.id,
      latestEval:  latestSelfEval,
      isManager:   !!(user?.profile?.is_manager || user?.profile?.role === 'manager'),
      onSaved: async () => {
        showToast('Bewertung gespeichert!', 'success')
        await loadData()
        rerender()
      },
    })
    document.body.appendChild(modal.render())
  }

  function buildStatCards(stats) {
    return `
      <div class="stat-grid">
        ${[
          { label: 'Mitarbeiter',     value: stats.total,          sub: locationLabel(activeLocation) },
          { label: 'Ø Score',          value: stats.avg !== null ? formatScore(stats.avg) : '–', sub: 'Aktuell' },
          { label: 'Top Performer',    value: stats.excellent,      sub: 'Score ≥ 4.0' },
          { label: 'Reklamationen',    value: stats.totalRecs,      sub: 'Gesamt (alle Zeiträume)', highlight: stats.totalRecs > 0 },
          { label: 'Promotion-Ready',  value: stats.promotionReady, sub: 'Junior → Senior', highlight: stats.promotionReady > 0 },
        ].map(item => `
          <div class="stat-card">
            <div class="stat-label">${item.label}</div>
            <div class="stat-value" style="${item.highlight ? 'color:var(--terracotta)' : ''}">${item.value}</div>
            <div class="stat-sub">${item.sub}</div>
          </div>
        `).join('')}
      </div>
    `
  }

  function buildDetailPanel(emp) {
    const allEvals    = getEvals(emp.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    const comparisonRow = allEvals.find(e => e.self_scores && Object.keys(e.self_scores).length > 0) ?? allEvals[0]
    const evals       = allEvals.filter(e => e.manager_scores && Object.keys(e.manager_scores).length > 0)
    const trend       = getTrend(evals)
    const qualityRate = calcQualityRate(evals)
    const totalRecs   = calcTotalReclamations(evals)
    const promotion   = checkPromotionEligibility(emp, evals)

    const piResult = evals[0] ? calculatePerformance(mapEntryToEngine(evals[0], emp.level, emp)) : null
    const qpi      = calcQPI(evals, emp.level)

    const mgrScores0  = evals[0]?.manager_scores ?? {}
    const selfScores0 = evals[0]?.self_scores ?? null
    const combinedScore = evals[0]
      ? (() => {
          const mgrW  = calcWeightedScore(mgrScores0, emp.level)
          const selfW = selfScores0 ? calcWeightedScore(selfScores0, emp.level) : mgrW
          return Math.round((0.75 * mgrW + 0.25 * selfW) * 10) / 10
        })()
      : null

    const bonusBadgeColor = { Gold: 'var(--gold)', Silber: '#A0A0A0', Bronze: 'var(--terracotta)' }

    return `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
        <button class="btn btn-ghost btn-sm" id="back-btn">← Zurück</button>
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
          <div class="stat-sub">von 100${piResult?.vetoAusgeloest ? ' · ⚠ Veto' : ''}</div>
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
          <div class="stat-label">Reklamationen</div>
          <div class="stat-value" style="${totalRecs > 0 ? 'color:var(--terracotta)' : ''}">${totalRecs}</div>
          <div class="stat-sub">gesamt</div>
        </div>
      </div>

      ${promotion.eligible ? `
        <div style="background:var(--success);color:#fff;border-radius:var(--radius-md);padding:14px 20px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between">
          <div>
            <strong>⬆ Promotion empfohlen</strong>
            <p style="font-size:0.8rem;margin-top:2px;opacity:0.9">Alle Kriterien für Senior-Status erfüllt.</p>
          </div>
          <button class="btn btn-sm" style="background:#fff;color:var(--success)" id="promote-btn" data-id="${emp.id}">Befördern</button>
        </div>
      ` : ''}

      <div class="card" style="margin-bottom:20px">
        <div class="card-header">
          <h4>PI-Verlauf</h4>
          <button class="btn btn-sm btn-accent" id="new-eval-btn" data-id="${emp.id}">+ Bewertung</button>
        </div>
        <div class="chart-container"><canvas id="detail-chart"></canvas></div>
      </div>

      ${comparisonRow ? buildComparisonCard(comparisonRow, emp.level, {
          selfLabel:    'Selbsteinschätzung (Mitarbeiter)',
          managerLabel: 'Meine Bewertung (Management)',
        }) : ''}

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

  function buildListHTML() {
    const stats = getStats()
    return `
      <div class="page-header">
        <h2>Dashboard</h2>
        <p style="color:var(--text-light);font-size:0.875rem">Studio 358 – Manager Übersicht</p>
      </div>

      <div class="location-tabs">
        <button class="location-tab ${activeLocation === 'all'    ? 'active' : ''}" data-loc="all">Alle</button>
        <button class="location-tab ${activeLocation === 'mitte'  ? 'active' : ''}" data-loc="mitte">Mitte</button>
        <button class="location-tab ${activeLocation === 'kadewe' ? 'active' : ''}" data-loc="kadewe">KaDeWe</button>
      </div>

      ${buildStatCards(stats)}

      <div class="card">
        <div class="card-header"><h4>Team Übersicht</h4></div>
        <div id="team-table-container"></div>
      </div>
    `
  }

  function buildHTML() {
    return selectedEmployee ? buildDetailPanel(selectedEmployee) : buildListHTML()
  }

  function attachEvents() {
    container.querySelectorAll('.location-tab[data-loc]').forEach(tab => {
      tab.addEventListener('click', () => { activeLocation = tab.dataset.loc; rerender() })
    })

    container.querySelector('#back-btn')?.addEventListener('click', () => {
      selectedEmployee = null; rerender()
    })

    container.querySelector('#new-eval-btn')?.addEventListener('click', e => {
      showEvaluateModal(e.currentTarget.dataset.id)
    })

    container.querySelector('#promote-btn')?.addEventListener('click', async e => {
      const id = e.currentTarget.dataset.id
      if (!confirm('Mitarbeiter zum Senior befördern?')) return
      const { error } = await supabase
        .from('profiles').update({ level: 'senior' }).eq('id', id)
      if (error) { showToast('Fehler: ' + error.message, 'error'); return }
      showToast('Beförderung erfolgreich!', 'success')
      await loadData()
      selectedEmployee = employees.find(emp => emp.id === id) ?? null
      rerender()
    })

    const tableContainer = container.querySelector('#team-table-container')
    if (tableContainer) {
      const table = TeamTable({
        employees: filteredEmployees(),
        evaluations,
        onEvaluate: showEvaluateModal,
        onViewDetail: id => {
          selectedEmployee = employees.find(e => e.id === id) ?? null
          rerender()
        },
      })
      tableContainer.appendChild(table.render())
    }

    if (selectedEmployee) {
      setTimeout(() => {
        const evals  = getEvals(selectedEmployee.id)
          .filter(e => e.manager_scores && Object.keys(e.manager_scores).length > 0)
        const level  = selectedEmployee.level || 'junior'
        const sorted = [...evals].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        const labels = sorted.map(e => e.evaluation_month
          ? new Date(e.evaluation_month + 'T12:00:00').toLocaleDateString('de-DE', { month: 'short', year: '2-digit' })
          : new Date(e.created_at).toLocaleDateString('de-DE', { month: 'short', year: '2-digit' }))
        const values = sorted.map(e => calculatePerformance(mapEntryToEngine(e, level)).PI_Monat)
        LineChart('detail-chart', { labels, values }).render()
      }, 0)
    }
  }

  function rerender() {
    if (!container) return
    container.innerHTML = buildHTML()
    attachEvents()
  }

  async function render() {
    const el = document.createElement('div')
    el.className = 'main-content'
    el.innerHTML = '<div class="loader"><div class="spinner"></div></div>'
    container = el

    await loadData()
    el.innerHTML = buildHTML()
    attachEvents()

    return el
  }

  return { render }
}

function locationLabel(loc) {
  return { all: 'Alle', mitte: 'Mitte', kadewe: 'KaDeWe' }[loc] ?? loc ?? '–'
}

function showToast(message, type = 'success') {
  let c = document.querySelector('.toast-container')
  if (!c) { c = document.createElement('div'); c.className = 'toast-container'; document.body.appendChild(c) }
  const t = document.createElement('div')
  t.className = `toast ${type}`
  t.textContent = message
  c.appendChild(t)
  setTimeout(() => t.remove(), 3500)
}
