import { supabase } from '../lib/supabase.js'
import { TeamTable } from '../components/TeamTable.js'
import { ScoreModal } from '../components/ScoreModal.js'
import { LineChart } from '../components/LineChart.js'
import { checkPromotionEligibility } from '../lib/skills.js'
import {
  formatScore, getLatestScore, getTrend, getTrendHTML,
  calcQualityRate, calcTotalReclamations,
} from '../lib/scoring.js'

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

    const modal = ScoreModal({
      employee:    emp,
      evaluatorId: user.id,
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
    const evals       = getEvals(emp.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    const latestScore = getLatestScore(evals)
    const trend       = getTrend(evals)
    const qualityRate = calcQualityRate(evals)
    const totalRecs   = calcTotalReclamations(evals)
    const promotion   = checkPromotionEligibility(emp, evals)

    return `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
        <button class="btn btn-ghost btn-sm" id="back-btn">← Zurück</button>
        <h3 style="color:var(--aubergine)">${emp.full_name}</h3>
        <span class="badge ${emp.level === 'senior' ? 'badge-aubergine' : 'badge-gold'}">${emp.level}</span>
        <span class="badge badge-neutral">${locationLabel(emp.location)}</span>
        ${promotion.eligible
          ? `<span class="badge badge-success" title="Promotion empfohlen">⬆ Promotion-Ready</span>`
          : emp.level === 'junior'
            ? `<span class="badge badge-neutral" title="${promotion.reason}" style="cursor:help">Promotion: ${promotion.reason.substring(0,30)}…</span>`
            : ''
        }
      </div>

      <div class="stat-grid" style="grid-template-columns:repeat(4,1fr)">
        <div class="stat-card">
          <div class="stat-label">Score</div>
          <div class="stat-value">${latestScore !== null ? formatScore(latestScore) : '–'}</div>
          <div class="stat-sub">/ 5.0 · ${getTrendHTML(trend)}</div>
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
          <div class="stat-sub">Gesamt (exakt)</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Bewertungen</div>
          <div class="stat-value">${evals.length}</div>
          <div class="stat-sub">Gesamt</div>
        </div>
      </div>

      ${promotion.eligible ? `
        <div style="background:var(--success);color:#fff;border-radius:var(--radius-md);padding:14px 20px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between">
          <div>
            <strong>⬆ Promotion empfohlen</strong>
            <p style="font-size:0.8rem;margin-top:2px;opacity:0.9">${emp.full_name} erfüllt alle Kriterien für den Senior-Status.</p>
          </div>
          <button class="btn btn-sm" style="background:#fff;color:var(--success)" id="promote-btn" data-id="${emp.id}">
            Befördern
          </button>
        </div>
      ` : ''}

      <div style="display:grid;grid-template-columns:2fr 1fr;gap:20px;margin-bottom:20px">
        <div class="card">
          <div class="card-header">
            <h4>Score-Verlauf</h4>
            <button class="btn btn-sm btn-accent" id="new-eval-btn" data-id="${emp.id}">+ Bewertung</button>
          </div>
          <div class="chart-container"><canvas id="detail-chart"></canvas></div>
        </div>

        <div class="card">
          <h4 style="margin-bottom:12px">Promotion-Check</h4>
          <div style="display:flex;flex-direction:column;gap:8px;font-size:0.875rem">
            ${[
              { label: 'Bewertungen ≥ 3',   ok: promotion.checks?.evaluations },
              { label: `Ø Score ≥ 4.0 (${promotion.avgScore ?? '–'})`, ok: promotion.checks?.score },
              { label: 'Pflicht-Skills',      ok: promotion.checks?.skills },
            ].map(c => `
              <div style="display:flex;align-items:center;gap:8px">
                <span style="color:${c.ok ? 'var(--success)' : 'var(--terracotta)'}">${c.ok ? '✓' : '✗'}</span>
                <span style="color:${c.ok ? 'var(--text-dark)' : 'var(--text-light)'}">${c.label}</span>
              </div>
            `).join('')}
          </div>
          ${emp.level === 'senior' ? `<p style="margin-top:12px;font-size:0.8rem;color:var(--text-light)">Bereits Senior</p>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h4>Bewertungsverlauf</h4>
        </div>
        ${evals.length ? `
          <div class="table-wrapper">
            <table>
              <thead>
                <tr><th>Datum</th><th>Score</th><th>Reklamationen</th><th>Quality Rate</th><th>Notizen</th></tr>
              </thead>
              <tbody>
                ${evals.map(e => {
                  const qr = e.appointments_count > 0
                    ? Math.round(((e.appointments_count - (e.complaints_count ?? 0)) / e.appointments_count) * 100)
                    : null
                  return `
                    <tr>
                      <td style="color:var(--text-mid)">${new Date(e.created_at).toLocaleDateString('de-DE')}</td>
                      <td style="font-weight:600;color:var(--aubergine)">${formatScore(e.score)}</td>
                      <td style="color:${(e.complaints_count ?? 0) > 0 ? 'var(--terracotta)' : 'var(--success)'}">
                        ${e.complaints_count ?? 0}
                      </td>
                      <td>${qr !== null ? qr + '%' : '–'}</td>
                      <td style="color:var(--text-light);font-size:0.8rem">${e.notes || '–'}</td>
                    </tr>
                  `
                }).join('')}
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
        const evals = getEvals(selectedEmployee.id)
        LineChart('detail-chart', evals).render()
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
