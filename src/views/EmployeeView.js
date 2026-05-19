import { supabase } from '../lib/supabase.js'
import { LineChart } from '../components/LineChart.js'
import { getCriteriaForLevel, SCORE_LABELS } from '../lib/criteria.js'
import { getAllSkills } from '../lib/skills.js'
import {
  formatScore, getTrend, getTrendHTML, getScoreLabel,
  calcQualityRate, getLowScoringCriteria, calcWeightedScore,
} from '../lib/scoring.js'
import { calculatePerformance, mapEntryToEngine, calcQPI } from '../lib/scoringEngine.js'
import { buildComparisonCard } from '../lib/buildComparisonCard.js'
import { ScoreModal } from '../components/ScoreModal.js'

export function EmployeeView({ user, onNavigate }) {
  let evaluations = []   // entries with manager scores (for PI, QPI, history stats)
  let allEntries  = []   // every row for this employee (for chart fallback + comparison card)
  let latestEntry = null // most recent entry of any kind
  let sops = []
  let selectedSOPId = null
  let container = null

  async function loadData() {
    const [evalRes, sopRes] = await Promise.all([
      supabase.from('performance_entries').select('*').eq('employee_id', user.id).order('created_at', { ascending: false }),
      supabase.from('sops').select('*').order('updated_at', { ascending: false }),
    ])
    const all   = evalRes.data ?? []
    allEntries  = all
    evaluations = all.filter(e => e.manager_scores && Object.keys(e.manager_scores).length > 0)
    latestEntry = all[0] ?? null
    sops        = sopRes.data ?? []
  }

  function getLatest() { return evaluations[0] ?? null }

  function openSelfAssessmentModal() {
    const employee = {
      id:        user.id,
      full_name: user.profile?.full_name || user.email,
      level:     user.profile?.level || 'junior',
    }
    const modal = ScoreModal({
      employee,
      evaluatorId:      user.id,
      isSelfAssessment: true,
      latestEval:       latestEntry,
      onSaved: async () => {
        await loadData()
        rerender()
      },
    })
    document.body.appendChild(modal.render())
  }

  function buildSkillCards() {
    const empSkills   = user.profile?.skills ?? []
    const allSkills   = getAllSkills(empSkills)
    const lowCriteria = getLowScoringCriteria(evaluations)

    const criteriaBySkill = {
      shellac:    ['technique', 'hygiene'],
      gel:        ['technique', 'hygiene'],
      dual_form:  ['technique'],
      manikuere:  ['service', 'hygiene'],
      'pediküre': ['service', 'hygiene'],
      ibx:        ['technique', 'learning'],
    }

    return `
      <div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center">
        ${allSkills.map(skill => {
          const hasSkill  = empSkills.includes(skill.id)
          const linkedSop = sops.find(s => s.associated_skill === skill.id)
          return `<span
            style="display:inline-block;font-size:10px;padding:2px 8px;border-radius:20px;white-space:nowrap;cursor:${linkedSop ? 'pointer' : 'default'};background:${hasSkill ? (skill.color || 'var(--aubergine)') : 'var(--cream-dark)'};color:${hasSkill ? '#fff' : 'var(--text-mid)'};"
            data-sop-id="${linkedSop?.id ?? ''}"
            title="${hasSkill ? 'Erworben' : 'In Ausbildung'}${linkedSop ? ' · SOP ansehen' : ''}"
          >${skill.label}${hasSkill ? ' ✓' : ''}</span>`
        }).join('')}
      </div>
    `
  }

  function buildSOPDetail(sop) {
    function getYoutubeEmbed(url) {
      if (!url) return null
      const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([A-Za-z0-9_-]{11})/)
      if (m) return `https://www.youtube.com/embed/${m[1]}`
      const v = url.match(/vimeo\.com\/(\d+)/)
      if (v) return `https://player.vimeo.com/video/${v[1]}`
      return null
    }

    function renderMarkdown(text) {
      if (!text) return ''
      return text
        .replace(/^## (.+)$/gm, '<h3 class="sop-h3">$1</h3>')
        .replace(/^### (.+)$/gm, '<h4 class="sop-h4">$1</h4>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>\n?)+/g, s => `<ul class="sop-list">${s}</ul>`)
        .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
        .replace(/\n\n/g, '</p><p>')
    }

    const embed = getYoutubeEmbed(sop.video_url)

    return `
      <button class="btn btn-ghost btn-sm" id="back-to-profile" style="margin-bottom:20px">← Zurück</button>
      <div class="card">
        <div class="card-header">
          <h3 style="color:var(--aubergine)">${sop.title}</h3>
          <span style="font-size:0.75rem;color:var(--text-light)">
            ${new Date(sop.updated_at).toLocaleDateString('de-DE')}
          </span>
        </div>

        ${embed ? `
          <div style="margin-bottom:24px;border-radius:var(--radius-md);overflow:hidden;aspect-ratio:16/9">
            <iframe src="${embed}" width="100%" height="100%"
              frameborder="0" allowfullscreen style="display:block"></iframe>
          </div>
        ` : ''}

        ${sop.content ? `<div class="sop-content"><p>${renderMarkdown(sop.content)}</p></div>` : ''}

        ${sop.pdf_link ? `
          <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--cream-dark)">
            <a href="${sop.pdf_link}" target="_blank" rel="noopener" class="btn btn-ghost">↓ PDF herunterladen</a>
          </div>
        ` : ''}
      </div>
    `
  }

  function buildHTML() {
    if (selectedSOPId) {
      const sop = sops.find(s => s.id === selectedSOPId)
      if (sop) return buildSOPDetail(sop)
    }

    const latest      = getLatest()
    const trend       = getTrend(evaluations)
    const qualityRate = calcQualityRate(evaluations)
    const level       = user.profile?.level || 'junior'

    // Use any available entry for PI (manager-scored preferred, self-assessment as fallback)
    const latestForPI = latest ?? latestEntry
    const engineInput = latestForPI ? mapEntryToEngine(latestForPI, level, user.profile) : null
    const piResult    = engineInput ? calculatePerformance(engineInput) : null
    const qpi        = calcQPI(evaluations, level)
    const bonusStufe = piResult?.bonusStufe ?? null

    const mgrScores0    = latest?.manager_scores ?? {}
    const selfScores0   = latest?.self_scores ?? null
    const combinedScore = latest
      ? (() => {
          const mgrW  = calcWeightedScore(mgrScores0, level)
          const selfW = selfScores0 ? calcWeightedScore(selfScores0, level) : mgrW
          return Math.round((0.75 * mgrW + 0.25 * selfW) * 10) / 10
        })()
      : null

    const avgOf   = s => { if (!s) return null; const v = Object.values(s).filter(x => x > 0); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null }
    const mgAvg   = avgOf(Object.keys(mgrScores0).length ? mgrScores0 : null)
    const selfAvg = avgOf(selfScores0)

    const bonusBadgeColor = {
      Gold:         'var(--gold)',
      Silber:       '#A0A0A0',
      Bronze:       'var(--terracotta)',
      'Kein Bonus': 'var(--text-light)',
    }

    const selfDate = latestEntry?.self_assessed_at
      ? new Date(latestEntry.self_assessed_at).toLocaleDateString('de-DE')
      : null

    return `
      <div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <h2>Meine Performance</h2>
          <p style="color:var(--text-light);font-size:0.875rem">
            Willkommen, ${user.profile?.full_name || user.email}
            · <span class="badge ${level === 'senior' ? 'badge-aubergine' : 'badge-gold'}">${level}</span>
          </p>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <button class="btn btn-accent btn-sm" id="self-assess-btn">Selbstbewertung abgeben</button>
          <span style="font-size:0.75rem;color:var(--text-light)">
            ${selfDate ? `Letzte Selbstbewertung: ${selfDate}` : 'Noch keine Selbstbewertung'}
          </span>
        </div>
      </div>

      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">Aktueller Score</div>
          <div class="stat-value">${combinedScore !== null ? formatScore(combinedScore) : '–'}</div>
          <div class="stat-sub">von 5.0${selfScores0 ? ' · 75/25' : ''}</div>
        </div>
        <div class="stat-card" style="${piResult?.vetoAusgeloest ? 'border-left:3px solid var(--terracotta)' : ''}">
          <div class="stat-label">Performance Index</div>
          <div class="stat-value" style="color:${piResult?.vetoAusgeloest ? 'var(--terracotta)' : 'var(--aubergine)'}">
            ${piResult?.vetoAusgeloest
              ? '<strong>0 <span style="font-size:0.75rem">(VETO)</span></strong>'
              : piResult != null
                ? String(piResult.PI_Monat)
                : 'Keine Daten'
            }
          </div>
          <div class="stat-sub">von 100 · ${piResult?.vetoAusgeloest ? '⚠ Sicherheitsveto' : piResult != null ? 'aktueller Monat' : 'Bewertung ausstehend'}</div>
          ${piResult?.vetoAusgeloest && piResult.vetoCauses?.length ? `
            <div style="font-size:0.62rem;color:var(--terracotta);margin-top:4px;line-height:1.5">
              ${piResult.vetoCauses.map(c => `⚠ ${c}`).join('<br>')}
            </div>
          ` : ''}
        </div>
        <div class="stat-card">
          <div class="stat-label">Quartal QPI</div>
          <div class="stat-value" style="color:var(--aubergine)">
            ${qpi !== null ? qpi : '–'}
          </div>
          <div class="stat-sub">${qpi === null ? 'mind. 3 Bewertungen nötig' : 'Ø letzte 3 Monate'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Bonusstufe</div>
          <div class="stat-value" style="font-size:1.4rem;color:${bonusBadgeColor[bonusStufe] ?? 'var(--text-light)'}">
            ${bonusStufe ?? '–'}
          </div>
          <div class="stat-sub">${qpi !== null ? 'QPI ' + qpi : 'QPI noch nicht berechenbar'}</div>
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

      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><h4>Score-Verlauf</h4></div>
        <div class="chart-container"><canvas id="employee-chart"></canvas></div>
      </div>

      ${latestEntry
        ? buildComparisonCard(latestEntry, level)
        : `<div class="card" style="margin-bottom:24px"><div class="empty-state"><span class="empty-state-icon">◉</span><p>Noch keine Bewertung vorhanden.</p></div></div>`
      }

      <div class="card" style="margin-bottom:24px">
        <div class="card-header">
          <h4>Meine Skills</h4>
          <button class="btn btn-ghost btn-sm" id="goto-sops">Zur Wissensdatenbank →</button>
        </div>
        ${buildSkillCards()}
      </div>

      ${evaluations.length > 1 ? `
        <div class="card">
          <div class="card-header"><h4>Bewertungsverlauf</h4></div>
          <div class="table-wrapper">
            <table>
              <thead>
                <tr><th>Datum</th><th>Score</th><th>Quality Rate</th><th>Einstufung</th><th>Notizen</th></tr>
              </thead>
              <tbody>
                ${evaluations.map(e => {
                  const reworks = e.reworks_count ?? e.complaints_count ?? 0
                  const qr = e.appointments_count > 0
                    ? Math.round(((e.appointments_count - reworks) / e.appointments_count) * 100)
                    : null
                  return `
                    <tr>
                      <td style="color:var(--text-mid)">${e.evaluation_month ? new Date(e.evaluation_month + 'T12:00:00').toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }) : new Date(e.created_at).toLocaleDateString('de-DE')}</td>
                      <td style="font-weight:600;color:var(--aubergine)">${formatScore(e.score)}</td>
                      <td style="color:${qr !== null && qr >= 95 ? 'var(--success)' : 'var(--terracotta)'}">
                        ${qr !== null ? qr + '%' : '–'}
                      </td>
                      <td><span class="badge badge-neutral">${getScoreLabel(e.score)}</span></td>
                      <td style="color:var(--text-light);font-size:0.8rem">${e.notes || '–'}</td>
                    </tr>
                  `
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      ` : ''}
    `
  }

  function attachEvents() {
    container.querySelector('#self-assess-btn')?.addEventListener('click', openSelfAssessmentModal)

    container.querySelector('#goto-sops')?.addEventListener('click', () => {
      onNavigate?.('sops')
    })

    container.querySelectorAll('.skill-sop-btn, [data-sop-id]').forEach(el => {
      const sopId = el.dataset.sopId
      if (!sopId) return
      el.addEventListener('click', e => {
        e.stopPropagation()
        selectedSOPId = sopId
        rerender()
      })
    })

    container.querySelector('#back-to-profile')?.addEventListener('click', () => {
      selectedSOPId = null
      rerender()
    })

    setTimeout(() => {
      const level = user.profile?.level || 'junior'
      // Prefer manager-scored entries for the chart; fall back to all entries so the
      // chart is never empty while waiting for the manager to complete their rating.
      const chartSrc = evaluations.length ? evaluations : allEntries
      const sorted   = [...chartSrc].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      const labels   = sorted.map(e => e.evaluation_month
        ? new Date(e.evaluation_month + 'T12:00:00').toLocaleDateString('de-DE', { month: 'short', year: '2-digit' })
        : new Date(e.created_at).toLocaleDateString('de-DE', { month: 'short', year: '2-digit' }))
      const values = sorted.map(e => calculatePerformance(mapEntryToEngine(e, level)).PI_Monat)
      LineChart('employee-chart', { labels, values }).render()
    }, 0)
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
