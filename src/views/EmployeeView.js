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
  let appointments = []              // manager_appointments for this employee
  let managerId    = null            // ID of the studio manager (for appointment requests)
  let selectedSOPId = null
  let container = null

  async function loadData() {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)

    const [evalRes, sopRes, hoursRes, analyticsRes, empSkillsRes, apptRes, mgrRes] = await Promise.all([
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
      supabase.from('manager_appointments')
        .select('*')
        .eq('employee_id', user.id)
        .order('scheduled_date', { ascending: false }),
      supabase.from('profiles')
        .select('id')
        .or('is_manager.eq.true,role.eq.manager')
        .limit(1)
        .maybeSingle(),
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
    appointments = apptRes.data ?? []
    managerId    = mgrRes.data?.id ?? null
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

  function buildAppointmentsSection() {
    const fmtDate = d => { if (!d) return '–'; const dt = new Date(d); return isNaN(dt) ? '–' : dt.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' }) }
    const fmtTime = d => { if (!d) return null; const dt = new Date(d); if (isNaN(dt)) return null; const h = dt.getHours(), m = dt.getMinutes(); if (!h && !m) return null; return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ' Uhr' }
    const fmtLoc  = l => ({ mitte: 'Studio Mitte', kadewe: 'KaDeWe' }[l] ?? l ?? '–')

    const pendingInvites    = appointments.filter(a => a.status === 'pending_employee' && a.initiated_by !== user.id)
    const myPendingRequests = appointments.filter(a => a.status === 'pending_manager'  && a.initiated_by === user.id)
    const confirmed         = appointments.filter(a => a.status === 'confirmed')

    const isEmpty = !pendingInvites.length && !myPendingRequests.length && !confirmed.length

    return `
      <div class="card" style="margin-bottom:24px">
        <div class="card-header">
          <h4>📅 Manager-Gespräche & Termine</h4>
          <button class="btn btn-ghost btn-sm" id="btn-new-appt">+ Termin anfragen</button>
        </div>

        ${pendingInvites.length > 0 ? `
          <div style="padding:12px 16px 4px">
            <div style="font-size:0.7rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--terracotta);margin-bottom:8px">Offene Einladungen vom Manager</div>
            ${pendingInvites.map(a => `
              <div style="padding:10px 0;border-bottom:1px solid var(--cream-dark);display:flex;justify-content:space-between;align-items:center;gap:10px">
                <div>
                  <div style="font-weight:600;font-size:0.9rem;color:var(--aubergine)">${fmtDate(a.scheduled_date)}${fmtTime(a.scheduled_date) ? ' · ' + fmtTime(a.scheduled_date) : ''}</div>
                  <div style="font-size:0.78rem;color:var(--text-mid)">${a.type === 'online' ? '🌐 Online · Google Meet' : '📍 ' + fmtLoc(a.location)}</div>
                  ${a.note ? `<div style="font-size:0.75rem;color:var(--text-light);margin-top:2px">${a.note}</div>` : ''}
                </div>
                <div style="display:flex;gap:6px;flex-shrink:0">
                  <button class="btn-confirm-appt" data-id="${a.id}" style="background:#27AE60;color:#fff;border:none;border-radius:var(--radius-sm);padding:5px 10px;font-size:0.82rem;cursor:pointer;font-weight:600">✓</button>
                  <button class="btn-decline-appt" data-id="${a.id}" style="background:var(--terracotta);color:#fff;border:none;border-radius:var(--radius-sm);padding:5px 10px;font-size:0.82rem;cursor:pointer">✕</button>
                </div>
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${myPendingRequests.length > 0 ? `
          <div style="padding:12px 16px 4px">
            <div style="font-size:0.7rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--gold);margin-bottom:8px">Meine Anfragen · Ausstehend</div>
            ${myPendingRequests.map(a => `
              <div style="padding:8px 0;border-bottom:1px solid var(--cream-dark);display:flex;justify-content:space-between;align-items:center;gap:10px">
                <div>
                  <div style="font-weight:600;font-size:0.85rem;color:var(--aubergine)">${fmtDate(a.scheduled_date)}${fmtTime(a.scheduled_date) ? ' · ' + fmtTime(a.scheduled_date) : ''}</div>
                  ${a.note ? `<div style="font-size:0.75rem;color:var(--text-light)">${a.note}</div>` : ''}
                </div>
                <span style="font-size:0.72rem;color:var(--gold);background:rgba(212,162,66,0.12);padding:3px 8px;border-radius:var(--radius-sm);white-space:nowrap">Ausstehend</span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${confirmed.length > 0 ? `
          <div style="padding:12px 16px 4px">
            <div style="font-size:0.7rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#27AE60;margin-bottom:8px">Bestätigte Termine</div>
            ${confirmed.map(a => `
              <div style="padding:10px 0;border-bottom:1px solid var(--cream)">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
                  <div>
                    <div style="font-weight:600;font-size:0.9rem;color:var(--aubergine)">${fmtDate(a.scheduled_date)}${fmtTime(a.scheduled_date) ? ' · ' + fmtTime(a.scheduled_date) : ''}</div>
                    <div style="font-size:0.78rem;color:var(--text-mid)">${a.type === 'online' ? '🌐 Online' : '📍 ' + fmtLoc(a.location)}</div>
                    ${a.note ? `<div style="font-size:0.75rem;color:var(--text-light);margin-top:2px">${a.note}</div>` : ''}
                  </div>
                  ${a.type === 'online' && a.meet_link ? `
                    <div style="display:flex;gap:6px;flex-shrink:0">
                      <a href="${a.meet_link}" target="_blank" rel="noopener" style="background:#1a73e8;color:#fff;border:none;border-radius:var(--radius-sm);padding:6px 12px;font-size:0.78rem;font-weight:600;text-decoration:none;white-space:nowrap">📹 Meet beitreten</a>
                      <button class="btn-copy-meet" data-link="${a.meet_link}" style="background:var(--cream-dark);border:none;border-radius:var(--radius-sm);padding:6px 10px;font-size:0.85rem;cursor:pointer" title="Link kopieren">📋</button>
                    </div>
                  ` : ''}
                </div>
                ${a.protocol_text ? `
                  <div style="margin-top:10px;background:rgba(61,43,53,0.04);border-radius:var(--radius-sm);padding:10px 12px;border-left:3px solid var(--aubergine)">
                    <div style="font-size:0.72rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--aubergine);margin-bottom:6px">Gesprächsprotokoll</div>
                    <div style="font-size:0.85rem;color:var(--text-mid);white-space:pre-wrap">${a.protocol_text}</div>
                    ${a.is_signed_off
                      ? `<div style="margin-top:8px;font-size:0.75rem;color:#27AE60;font-weight:600">✓ Du hast dieses Protokoll bestätigt</div>`
                      : `<button class="btn-signoff-protocol" data-id="${a.id}"
                          style="margin-top:10px;width:100%;padding:10px 14px;background:#27AE60;color:#fff;border:none;border-radius:var(--radius-sm);font-size:0.82rem;font-weight:700;cursor:pointer;line-height:1.4;text-align:center">
                          ✓ Ich habe das Gesprächsprotokoll gelesen und bestätige es
                        </button>`
                    }
                  </div>
                ` : ''}
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${isEmpty ? `
          <div class="empty-state" style="padding:20px">
            <span class="empty-state-icon" style="font-size:1.5rem">📅</span>
            <p>Noch keine Termine. Tippe auf "+ Termin anfragen".</p>
          </div>
        ` : '<div style="height:4px"></div>'}
      </div>
    `
  }

  function openNewAppointmentModal() {
    const today = localDate()
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:16px;box-sizing:border-box'
    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:360px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:18px 20px 0">
          <h3 style="margin:0;font-size:1.05rem;color:var(--aubergine)">Termin anfragen</h3>
          <button id="na-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-light);line-height:1;padding:4px">✕</button>
        </div>
        <div style="padding:16px 20px;display:flex;flex-direction:column;gap:14px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Wunschdatum
            <input id="na-date" type="date" min="${today}" value="${today}" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.95rem;color:var(--aubergine)">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Wunschuhrzeit
            <select id="na-time" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;color:var(--aubergine);background:var(--white)">
              ${(()=>{let o='<option value="">– Keine Uhrzeit –</option>';for(let h=8;h<=21;h++){const hh=String(h).padStart(2,'0');o+=`<option value="${hh}:00">${hh}:00 Uhr</option>`;if(h<21)o+=`<option value="${hh}:30">${hh}:30 Uhr</option>`;}return o;})()}
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Notiz (optional)
            <textarea id="na-note" rows="2" placeholder="Thema, Anliegen..." style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.85rem;resize:none;font-family:inherit"></textarea>
          </label>
        </div>
        <div style="padding:0 20px 20px">
          <button id="na-save" class="btn btn-accent" style="width:100%;justify-content:center">Anfrage senden</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    overlay.querySelector('#na-close').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
    overlay.querySelector('#na-save').addEventListener('click', async () => {
      const date = overlay.querySelector('#na-date').value
      const time = overlay.querySelector('#na-time').value || null
      const note = overlay.querySelector('#na-note').value.trim() || null
      if (!date) { alert('Bitte wähle ein Datum.'); return }
      const btn = overlay.querySelector('#na-save')
      btn.disabled = true; btn.textContent = 'Senden...'
      const { error } = await supabase.from('manager_appointments').insert({
        employee_id:    user.id,
        manager_id:     managerId,
        scheduled_date: time ? `${date}T${time}:00` : date,
        note:           note || null,
        status:         'pending_manager',
        initiated_by:   user.id,
        type:           'offline',
      })
      if (error) {
        showToast('Fehler: ' + error.message, 'error')
        btn.disabled = false; btn.textContent = 'Anfrage senden'
        return
      }
      showToast('Terminanfrage gesendet!')
      overlay.remove()
      await loadData()
      rerender()
    })
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
          <h2>Performance Tracker</h2>
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

      ${buildAppointmentsSection()}

      ${evaluations.length > 1 ? `
        <div class="card" style="margin-bottom:24px">
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

      <div class="card">
        <div class="card-header">
          <h4>Meine Skills</h4>
          <button class="btn btn-ghost btn-sm" id="goto-sops">Zur Wissensdatenbank →</button>
        </div>
        ${buildSkillCards()}
      </div>
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

    container.querySelector('#btn-new-appt')?.addEventListener('click', openNewAppointmentModal)

    container.querySelectorAll('.btn-confirm-appt[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { error } = await supabase.from('manager_appointments')
          .update({ status: 'confirmed' }).eq('id', btn.dataset.id)
        if (error) { showToast('Fehler: ' + error.message, 'error'); return }
        showToast('Termin bestätigt!')
        await loadData(); rerender()
      })
    })

    container.querySelectorAll('.btn-decline-appt[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Einladung ablehnen?')) return
        const { error } = await supabase.from('manager_appointments')
          .update({ status: 'cancelled' }).eq('id', btn.dataset.id)
        if (error) { showToast('Fehler: ' + error.message, 'error'); return }
        showToast('Einladung abgelehnt.')
        await loadData(); rerender()
      })
    })

    container.querySelectorAll('.btn-signoff-protocol[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = 'Speichern...'
        const { error } = await supabase.from('manager_appointments')
          .update({ is_signed_off: true }).eq('id', btn.dataset.id)
        if (error) {
          showToast('Fehler: ' + error.message, 'error')
          btn.disabled = false; btn.textContent = '✓ Ich habe das Gesprächsprotokoll gelesen und bestätige es'
          return
        }
        showToast('Protokoll bestätigt!')
        await loadData(); rerender()
      })
    })

    container.querySelectorAll('.btn-copy-meet[data-link]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(btn.dataset.link)
          const orig = btn.textContent
          btn.textContent = '✓'
          setTimeout(() => { btn.textContent = orig }, 1500)
        } catch (_) {
          showToast('Meet-Link: ' + btn.dataset.link)
        }
      })
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

function showToast(message, type = 'success') {
  let c = document.querySelector('.toast-container')
  if (!c) { c = document.createElement('div'); c.className = 'toast-container'; document.body.appendChild(c) }
  const t = document.createElement('div')
  t.className = `toast ${type}`
  t.textContent = message
  c.appendChild(t)
  setTimeout(() => t.remove(), 3500)
}
