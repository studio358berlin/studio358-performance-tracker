import { getCriteriaForLevel } from './criteria.js'
import { calculatePerformance, mapEntryToEngine } from './scoringEngine.js'

const COL_SELF = '#4A90B8'
const COL_MGR  = 'var(--aubergine)'

const BONUS_COLOR = {
  Gold:         'var(--gold)',
  Silber:       '#A0A0A0',
  Bronze:       'var(--terracotta)',
  'Kein Bonus': 'var(--text-light)',
}

function bar(val, color, bg) {
  const pct = val != null ? (val / 5) * 100 : 0
  return `
    <div style="display:flex;align-items:center;gap:6px">
      <div style="flex:1;height:7px;background:${bg};border-radius:4px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:width 0.3s"></div>
      </div>
      <span style="font-size:0.75rem;font-weight:600;color:${color};min-width:28px;text-align:right">
        ${val != null ? val + '/5' : '–'}
      </span>
    </div>
  `
}

function fmtTs(ts) {
  if (!ts) return null
  return new Date(ts).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) + ' Uhr'
}

/**
 * Renders a two-column score comparison card.
 * @param {object} evaluation  - performance_entries row
 * @param {string} level       - 'junior' | 'senior'
 * @param {object} opts
 * @param {string} opts.selfLabel    - header for left column
 * @param {string} opts.managerLabel - header for right column
 */
export function buildComparisonCard(evaluation, level, {
  selfLabel    = 'Meine Einschätzung',
  managerLabel = 'Bewertung Management',
} = {}) {
  const criteria   = getCriteriaForLevel(level)
  const mgScores   = evaluation.manager_scores ?? {}
  const selfScores = evaluation.self_scores    ?? null

  const hasMgrScores = mgScores && Object.keys(mgScores).length > 0
  const piResult     = hasMgrScores ? calculatePerformance(mapEntryToEngine(evaluation, level)) : null
  const managerTs    = fmtTs(evaluation.manager_assessed_at)
  const selfTs    = fmtTs(evaluation.self_assessed_at)

  const monthLabel = evaluation.evaluation_month
    ? new Date(evaluation.evaluation_month + 'T12:00:00')
        .toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
    : new Date(evaluation.created_at).toLocaleDateString('de-DE')

  return `
    <div class="card" style="margin-bottom:24px">
      <div class="card-header">
        <h4>Bewertungsvergleich</h4>
        <div style="display:flex;align-items:center;gap:12px">
          <span style="font-size:0.8rem;color:var(--text-light)">${monthLabel}</span>
          ${piResult ? `
            <span style="font-family:var(--font-heading);font-size:0.95rem;color:var(--aubergine);font-weight:700">
              PI&thinsp;${piResult.PI_Monat}
            </span>
            <span style="font-size:0.8rem;font-weight:600;color:${BONUS_COLOR[piResult.bonusStufe] ?? 'var(--text-light)'}">
              ${piResult.bonusStufe}
            </span>
            ${piResult.vetoAusgeloest ? `<span style="font-size:0.75rem;color:var(--terracotta)">⚠ Veto</span>` : ''}
          ` : ''}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px">
        <div style="padding:10px 14px;background:rgba(74,144,184,0.09);border-radius:var(--radius-sm);border-left:3px solid ${COL_SELF}">
          <div style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:${COL_SELF}">
            ${selfLabel}
          </div>
          <div style="font-size:0.7rem;color:var(--text-light);margin-top:3px">
            ${selfTs ? `Erstellt am ${selfTs}` : '<em>Noch nicht abgegeben</em>'}
          </div>
        </div>
        <div style="padding:10px 14px;background:rgba(61,43,53,0.06);border-radius:var(--radius-sm);border-left:3px solid ${COL_MGR}">
          <div style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:${COL_MGR}">
            ${managerLabel}
          </div>
          <div style="font-size:0.7rem;color:var(--text-light);margin-top:3px">
            ${managerTs ? `Erstellt am ${managerTs}` : '<em>Noch nicht bewertet</em>'}
          </div>
        </div>
      </div>

      ${criteria.map(c => {
        const selfVal  = selfScores ? (selfScores[c.id] ?? null) : null
        const mgVal    = mgScores[c.id] ?? null
        const combined = (mgVal != null && selfVal != null)
          ? (0.75 * mgVal + 0.25 * selfVal).toFixed(2)
          : null
        return `
          <div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--cream-dark)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
              <span style="font-size:0.82rem;font-weight:500;color:var(--text-dark)">${c.label}</span>
              <span style="font-size:0.72rem;color:var(--text-light)">${Math.round(c.weight * 100)}%</span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:3px">
              ${bar(selfVal, COL_SELF, 'rgba(74,144,184,0.12)')}
              ${bar(mgVal,   COL_MGR,  'rgba(61,43,53,0.1)')}
            </div>
            ${combined != null ? `
              <div style="text-align:right;font-size:0.7rem;color:var(--text-light)">
                Kombiniert&thinsp;(75/25)&thinsp;→&thinsp;<strong style="color:var(--text-mid)">${combined}&thinsp;/&thinsp;5</strong>
              </div>
            ` : ''}
          </div>
        `
      }).join('')}
    </div>
  `
}
