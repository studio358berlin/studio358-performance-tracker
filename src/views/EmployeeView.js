import { supabase } from '../lib/supabase.js'
import { LineChart } from '../components/LineChart.js'
import { getCriteriaForLevel, SCORE_LABELS } from '../lib/criteria.js'
import {
  formatScore, getScoreLabel, calcWeightedScore,
} from '../lib/scoring.js'
import { calculatePerformance, mapEntryToEngine } from '../lib/scoringEngine.js'
import { buildComparisonCard } from '../lib/buildComparisonCard.js'
import { ScoreModal } from '../components/ScoreModal.js'

export function EmployeeView({ user, onNavigate }) {
  let evaluations = []   // entries with manager scores (for PI, QPI, history stats)
  let allEntries  = []   // every row for this employee (for chart fallback + comparison card)
  let latestEntry = null // most recent entry of any kind
  let sops = []
  let hoursData    = []   // employee_daily_hours rows for current month
  let analyticsRow = null // row from employee_hours_analytics (contains target_hours_current_month)
  let employeeSkillsWithNames = []   // employee_skills JOIN skills — avoids UUID labels
  let selectedSOPId = null
  let container = null

  async function loadData() {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)

    const [evalRes, sopRes, hoursRes, analyticsRes, empSkillsRes] = await Promise.all([
      supabase.from('performance_entries').select('*').eq('employee_id', user.id).order('created_at', { ascending: false }),
      supabase.from('sops').select('*').order('updated_at', { ascending: false }),
      supabase.from('employee_daily_hours')
        .select('date, hours_worked, break_minutes')
        .eq('employee_id', user.id)
        .gte('date', monthStart),
      supabase.from('employee_hours_analytics')
        .select('net_hours_month, target_hours_current_month')
        .eq('employee_id', user.id)
        .maybeSingle(),
      supabase.from('employee_skills')
        .select('skill_id, skills(id, name, label, color, category)')
        .eq('employee_id', user.id),
    ])
    const all    = evalRes.data ?? []
    allEntries   = all
    evaluations  = all.filter(e => e.manager_scores && Object.keys(e.manager_scores).length > 0)
    latestEntry  = all[0] ?? null
    sops         = sopRes.data ?? []
    hoursData    = hoursRes.data ?? []
    analyticsRow = analyticsRes.data ?? null
    employeeSkillsWithNames = (empSkillsRes.data ?? []).map(row => ({
      id:       row.skill_id,
      label:    row.skills?.name || row.skills?.label || String(row.skill_id),
      color:    row.skills?.color || '#A08090',
      category: row.skills?.category || 'custom',
    }))
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
    if (!employeeSkillsWithNames.length) {
      return `<div style="padding:0 20px 16px;font-size:0.85rem;color:var(--text-light)">Noch keine Skills zugewiesen.</div>`
    }
    return `
      <div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center;padding:0 20px 16px">
        ${employeeSkillsWithNames.map(skill => {
          const linkedSop = sops.find(s => s.associated_skill === skill.id)
          return `<span
            style="display:inline-block;font-size:10px;padding:2px 8px;border-radius:20px;white-space:nowrap;cursor:${linkedSop ? 'pointer' : 'default'};background:${skill.color || 'var(--aubergine)'};color:#fff;"
            data-sop-id="${linkedSop?.id ?? ''}"
            title="Erworben${linkedSop ? ' · SOP ansehen' : ''}"
          >${skill.label} ✓</span>`
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
    const level       = user.profile?.level || 'junior'

    const mgrScores0    = latest?.manager_scores ?? {}
    const selfScores0   = latest?.self_scores ?? null
    const combinedScore = latest
      ? (() => {
          const mgrW  = calcWeightedScore(mgrScores0, level)
          const selfW = selfScores0 ? calcWeightedScore(selfScores0, level) : mgrW
          return Math.round((0.75 * mgrW + 0.25 * selfW) * 10) / 10
        })()
      : null

    const selfDate = latestEntry?.self_assessed_at
      ? new Date(latestEntry.self_assessed_at).toLocaleDateString('de-DE')
      : null

    const netMinsMonth  = hoursData.reduce((s, h) => s + Math.max(0, h.hours_worked * 60 - h.break_minutes), 0)
    const netHoursMonth = Number(analyticsRow?.net_hours_month  ?? (netMinsMonth / 60)) || 0
    const targetHours   = Number(analyticsRow?.target_hours_current_month ?? 160)       || 160
    const pct           = Math.round((netHoursMonth / targetHours) * 100)
    const barPct        = Math.min(pct, 100)
    const barColor      = pct >= 100 ? '#27AE60' : pct >= 60 ? 'var(--gold)' : 'var(--aubergine)'
    const balanceH      = netHoursMonth - targetHours
    const balanceStr    = (balanceH >= 0 ? '+' : '') + balanceH.toFixed(1) + ' Std.'
    const balanceColor  = balanceH >= 0 ? '#27AE60' : 'var(--terracotta)'
    const scoreColor    = combinedScore !== null
      ? (combinedScore >= 4 ? '#27AE60' : combinedScore >= 3 ? 'var(--gold)' : 'var(--terracotta)')
      : 'var(--text-light)'

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

      <!-- Aktueller Score -->
      <div class="card" style="margin-bottom:16px">
        <div style="padding:16px 20px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:0.72rem;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-light);margin-bottom:6px">Aktueller Score</div>
            <div style="font-size:2.2rem;font-weight:700;color:${scoreColor};line-height:1">${combinedScore !== null ? formatScore(combinedScore) : '–'}</div>
            <div style="font-size:0.78rem;color:var(--text-light);margin-top:5px">von 5.0${selfScores0 ? ' · 75/25 Manager/Selbst' : ''}</div>
          </div>
          <div style="width:60px;height:60px;border-radius:50%;border:3px solid ${scoreColor};display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <span style="font-size:1rem;font-weight:700;color:${scoreColor}">${combinedScore !== null ? formatScore(combinedScore) : '–'}</span>
          </div>
        </div>
      </div>

      <!-- Stunden-Konto Monat -->
      <div class="card" style="margin-bottom:24px">
        <div style="padding:16px 20px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
            <div style="font-size:0.72rem;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-light)">Stunden-Konto · Monat</div>
            <span style="font-size:0.78rem;font-weight:700;color:${balanceColor}">${netHoursMonth > 0 ? balanceStr : '–'}</span>
          </div>
          <div style="font-size:1.25rem;font-weight:700;color:var(--aubergine);margin-bottom:10px">
            ${netHoursMonth.toFixed(1)} / ${targetHours} Std.
          </div>
          <div style="height:10px;border-radius:5px;background:var(--cream-dark);overflow:hidden">
            <div style="height:100%;width:${barPct}%;background:${barColor};border-radius:5px;transition:width 0.4s ease"></div>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:5px">
            <span style="font-size:0.72rem;color:${pct >= 100 ? '#27AE60' : 'var(--text-mid)'}">
              ${pct}% ${pct >= 100 ? '· Ziel erreicht ✓' : 'des Monatsziels'}
            </span>
            <span style="font-size:0.72rem;color:var(--text-light)">${targetHours} Std. Soll</span>
          </div>
        </div>
      </div>

      <!-- Score-Verlauf (kompakt) -->
      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><h4>Score-Verlauf</h4></div>
        <div style="position:relative;height:110px;padding:8px 16px 12px">
          <canvas id="employee-chart"></canvas>
        </div>
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

function localDate() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function fmtEur(n) {
  return Number(n ?? 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
}
