import { formatScore, getTrend, getTrendHTML, getScoreColor } from '../lib/scoring.js'

export function TeamTable({ employees, evaluations, onEvaluate, onViewDetail, onDelete }) {
  function getEmployeeEvals(employeeId) {
    return evaluations.filter(e => e.employee_id === employeeId)
  }

  function getLatest(evals) {
    if (!evals.length) return null
    return [...evals].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    )[0]
  }

  function render() {
    const wrapper = document.createElement('div')
    wrapper.className = 'table-wrapper'

    if (!employees.length) {
      wrapper.innerHTML = `
        <div class="empty-state">
          <span class="empty-state-icon">◉</span>
          <p>Keine Mitarbeiter gefunden.</p>
        </div>
      `
      return wrapper
    }

    wrapper.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Mitarbeiter</th>
            <th>Location</th>
            <th>Level</th>
            <th>Letzter Score</th>
            <th>Trend</th>
            <th>Letzte Bewertung</th>
            <th style="text-align:right">Aktionen</th>
          </tr>
        </thead>
        <tbody>
          ${employees.map(emp => {
            const evals = getEmployeeEvals(emp.id)
            const latest = getLatest(evals)
            const trend = getTrend(evals)
            const score = latest ? Number(latest.score) : null
            const scoreColor = score ? getScoreColor(score) : '#A08090'

            return `
              <tr>
                <td>
                  <div style="display:flex;align-items:center;gap:10px">
                    <div class="sidebar-avatar" style="width:30px;height:30px;font-size:0.7rem;flex-shrink:0">
                      ${getInitials(emp.full_name)}
                    </div>
                    <div>
                      <div style="font-weight:500">${emp.full_name}</div>
                      ${emp.email ? `<div style="font-size:0.75rem;color:var(--text-light)">${emp.email}</div>` : ''}
                    </div>
                  </div>
                </td>
                <td>
                  <span class="badge badge-neutral">${locationLabel(emp.location)}</span>
                </td>
                <td>
                  <span class="badge ${emp.level === 'senior' ? 'badge-aubergine' : 'badge-gold'}">
                    ${emp.level || 'Junior'}
                  </span>
                </td>
                <td>
                  ${score !== null
                    ? `<span style="font-weight:600;color:${scoreColor}">${formatScore(score)}</span>
                       <span style="color:var(--text-light);font-size:0.75rem"> / 5.0</span>`
                    : '<span style="color:var(--text-light)">–</span>'
                  }
                </td>
                <td>${getTrendHTML(trend)}</td>
                <td style="color:var(--text-light);font-size:0.8rem">
                  ${latest
                    ? new Date(latest.created_at).toLocaleDateString('de-DE')
                    : '–'
                  }
                </td>
                <td style="text-align:right">
                  <div style="display:flex;gap:6px;justify-content:flex-end;align-items:center">
                    <button class="btn btn-sm btn-ghost btn-detail" data-id="${emp.id}">Detail</button>
                    <button class="btn btn-sm btn-accent btn-evaluate" data-id="${emp.id}">Bewerten</button>
                    <button class="btn btn-sm btn-delete" data-id="${emp.id}" data-name="${emp.full_name}" title="Mitarbeiter löschen" style="background:none;border:1px solid var(--terracotta);color:var(--terracotta);padding:4px 8px;border-radius:var(--radius-sm);cursor:pointer;line-height:1;transition:background var(--transition),color var(--transition)" onmouseover="this.style.background='var(--terracotta)';this.style.color='#fff'" onmouseout="this.style.background='none';this.style.color='var(--terracotta)'">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                    </button>
                  </div>
                </td>
              </tr>
            `
          }).join('')}
        </tbody>
      </table>
    `

    wrapper.querySelectorAll('.btn-evaluate').forEach(btn => {
      btn.addEventListener('click', () => onEvaluate(btn.dataset.id))
    })

    wrapper.querySelectorAll('.btn-detail').forEach(btn => {
      btn.addEventListener('click', () => onViewDetail(btn.dataset.id))
    })

    wrapper.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm(`Mitarbeiter "${btn.dataset.name}" wirklich löschen?\n\nDieser Vorgang kann nicht rückgängig gemacht werden.`)) {
          onDelete(btn.dataset.id)
        }
      })
    })

    return wrapper
  }

  return { render }
}

function getInitials(name = '') {
  return name.split(' ').filter(Boolean).slice(0, 2).map(n => n[0].toUpperCase()).join('')
}

function locationLabel(loc) {
  const labels = { mitte: 'Mitte', kadewe: 'KaDeWe' }
  return labels[loc] ?? loc ?? '–'
}
