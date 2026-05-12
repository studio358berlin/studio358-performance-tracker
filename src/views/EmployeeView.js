import { supabase } from '../lib/supabase.js'
import { LineChart } from '../components/LineChart.js'
import { getCriteriaForLevel, SCORE_LABELS } from '../lib/criteria.js'
import { getAllSkills } from '../lib/skills.js'
import {
  formatScore, getTrend, getTrendHTML, getScoreLabel,
  calcQualityRate, getLowScoringCriteria,
} from '../lib/scoring.js'
import { calculatePerformance, mapEntryToEngine, calcQPI } from '../lib/scoringEngine.js'
import { buildComparisonCard } from '../lib/buildComparisonCard.js'
import { ScoreModal } from '../components/ScoreModal.js'

export function EmployeeView({ user, onNavigate }) {
  let evaluations = []
  let sops = []
  let selectedSOPId = null
  let container = null

  async function loadData() {
    const [evalRes, sopRes] = await Promise.all([
      supabase.from('performance_entries').select('*').eq('employee_id', user.id).order('created_at', { ascending: false }),
      supabase.from('sops').select('*').order('updated_at', { ascending: false }),
    ])
    // Only keep manager evaluations; old is_self_assessment=true rows are excluded
    evaluations = (evalRes.data ?? []).filter(e => !e.is_self_assessment)
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
      latestEval:       getLatest(),
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
    const latestEval  = getLatest()
    const lowCriteria = getLowScoringCriteria(evaluations)

    const criteriaBySkill = {
      shellac:   ['technique', 'hygiene'],
      gel:       ['technique', 'hygiene'],
      dual_form: ['technique'],
      manikuere: ['service', 'hygiene'],
      pediküre:  ['service', 'hygiene'],
      ibx:       ['technique', 'learning'],
    }

    return `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px">
        ${allSkills.map(skill => {
          const hasSkill    = empSkills.includes(skill.id)
          const relatedLow  = (criteriaBySkill[skill.id] ?? []).some(c => lowCriteria.includes(c))
          const linkedSop   = sops.find(s => s.associated_skill === skill.id)

          return `
            <div class="skill-card ${hasSkill ? 'skill-card--active' : ''} ${relatedLow ? 'skill-card--warning' : ''}"
              style="border-top-color:${skill.color}"
              data-sop-id="${linkedSop?.id ?? ''}"
              data-has-sop="${!!linkedSop}">
              <div class="skill-icon" style="color:${skill.color}">${skill.icon}</div>
              <div class="skill-name">${skill.label}</div>
              ${hasSkill
                ? `<span class="badge badge-success" style="margin-top:6px;font-size:0.65rem">Erworben</span>`
                : `<span class="badge badge-neutral" style="margin-top:6px;font-size:0.65rem">In Ausbildung</span>`
              }
              ${relatedLow
                ? `<div class="skill-learn-badge">📖 Lernempfehlung</div>`
                : ''
              }
              ${linkedSop
                ? `<button class="skill-sop-btn" data-sop-id="${linkedSop.id}">SOP ansehen →</button>`
                : `<span style="font-size:0.7rem;color:var(--text-light);margin-top:4px">Keine SOP verknüpft</span>`
              }
            </div>
          `
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

    const piResult   = latest ? calculatePerformance(mapEntryToEngine(latest, level)) : null
    const qpi        = calcQPI(evaluations, level)
    const bonusStufe = piResult?.bonusStufe ?? null

    const bonusBadgeColor = {
      Gold:         'var(--gold)',
      Silber:       '#A0A0A0',
      Bronze:       'var(--terracotta)',
      'Kein Bonus': 'var(--text-light)',
    }

    const selfDate = latest?.self_assessed_at
      ? new Date(latest.self_assessed_at).toLocaleDateString('de-DE')
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
          <div class="stat-value">${latest ? formatScore(latest.score) : '–'}</div>
          <div class="stat-sub">von 5.0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Performance Index</div>
          <div class="stat-value" style="color:var(--aubergine)">
            ${piResult ? piResult.PI_Monat : '–'}
          </div>
          <div class="stat-sub">von 100 · ${piResult?.vetoAusgeloest ? '⚠ Veto' : 'aktueller Monat'}</div>
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

      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><h4>Score-Verlauf</h4></div>
        <div class="chart-container"><canvas id="employee-chart"></canvas></div>
      </div>

      ${latest
        ? buildComparisonCard(latest, level)
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
      const level  = user.profile?.level || 'junior'
      const sorted = [...evaluations].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      const labels = sorted.map(e => e.evaluation_month
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
