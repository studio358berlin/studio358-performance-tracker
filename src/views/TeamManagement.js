import { supabase } from '../lib/supabase.js'
import { ScoreModal } from '../components/ScoreModal.js'
import { TeamTable } from '../components/TeamTable.js'
import { LineChart } from '../components/LineChart.js'
import { getAllSkills, DEFAULT_SKILLS, checkPromotionEligibility } from '../lib/skills.js'
import { formatScore, getTrend, getTrendHTML, getLatestScore, calcQualityRate, calcTotalReclamations, calcWeightedScore } from '../lib/scoring.js'
import { calculatePerformance, mapEntryToEngine, calcQPI } from '../lib/scoringEngine.js'
import { buildComparisonCard } from '../lib/buildComparisonCard.js'

export function TeamManagement({ user }) {
  const STUDIO_SLUG   = { 'KaDeWe': 'kadewe', 'Studio Mitte': 'mitte' }
  const mgrStudios    = user?.profile?.role === 'manager' ? (user?.profile?.assigned_studios ?? []) : null
  const forcedLocSlug = mgrStudios?.length === 1 ? (STUDIO_SLUG[mgrStudios[0]] ?? null) : null

  function isEmpVisible(emp) {
    if (!mgrStudios)        return true
    if (!mgrStudios.length) return true
    return mgrStudios.some(s => (emp.assigned_studios ?? []).includes(s))
  }

  let employees      = []
  let evaluations    = []
  let employeeHours  = []   // employee_daily_hours rows for current month
  let monthlyTargets = []   // employee_monthly_targets for current month
  let activeLocation = forcedLocSlug ?? localStorage.getItem('activeLocation') ?? 'all'
  let view           = 'list'
  let selectedEmployee = null
  let showAddForm       = false
  let container         = null
  let availableSkills   = []   // from public.skills table
  let employeeSkillsMap = {}   // employee_id → skill_id[]
  let appointmentsMap   = {}   // employee_id → manager_appointments[]
  let allAppointments   = []   // flat list for global pending panel

  async function loadData() {
    const now             = new Date()
    const firstOfMonth    = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const firstOfMonthStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`

    const [empRes, evalRes, logsRes, hoursRes, targetsRes, skillsRes, empSkillsRes, apptsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('role', 'employee').order('full_name'),
      supabase.from('performance_entries').select('*').order('created_at', { ascending: false }),
      supabase.from('daily_revenue_logs').select('employee_id, tip').gte('created_at', firstOfMonth),
      supabase.from('employee_daily_hours')
        .select('employee_id, date, hours_worked, break_minutes, location_id, is_modified, original_hours, is_punctual')
        .gte('date', firstOfMonthStr),
      supabase.from('employee_monthly_targets')
        .select('employee_id, target_hours')
        .eq('year',  now.getFullYear())
        .eq('month', now.getMonth() + 1),
      supabase.from('skills').select('*').order('name'),
      supabase.from('employee_skills').select('employee_id, skill_id'),
      supabase.from('manager_appointments').select('*')
        .or(`manager_id.eq.${user.id},status.eq.pending_manager,status.eq.pending_employee`)
        .order('scheduled_date', { ascending: false }),
    ])
    employees     = (empRes.data ?? []).filter(isEmpVisible)
    evaluations   = evalRes.data ?? []
    employeeHours = hoursRes.data   ?? []
    monthlyTargets = targetsRes.data ?? []

    // Normalize skills from DB — fall back to DEFAULT_SKILLS if table is empty/missing
    const rawSkills = skillsRes.data ?? []
    availableSkills = rawSkills.length
      ? rawSkills.map(s => ({
          id:       s.id,
          label:    s.name || s.label || String(s.id),
          color:    s.color || '#A08090',
          category: s.category || 'custom',
        }))
      : DEFAULT_SKILLS

    // Build employee_id → skill_id[] lookup
    employeeSkillsMap = {}
    for (const row of (empSkillsRes.data ?? [])) {
      if (!employeeSkillsMap[row.employee_id]) employeeSkillsMap[row.employee_id] = []
      employeeSkillsMap[row.employee_id].push(row.skill_id)
    }

    // Build flat list + employee_id → appointments[] lookup
    allAppointments = apptsRes.data ?? []
    appointmentsMap = {}
    for (const a of allAppointments) {
      if (!appointmentsMap[a.employee_id]) appointmentsMap[a.employee_id] = []
      appointmentsMap[a.employee_id].push(a)
    }

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

  function calcPunctualityStats(empId) {
    const entries  = employeeHours.filter(h => h.employee_id === empId && h.hours_worked > 0)
    const total    = entries.length
    const punctual = entries.filter(h => h.is_punctual === true).length
    const late     = total - punctual
    const pct      = total > 0 ? Math.round((punctual / total) * 100) : null
    return { total, punctual, late, pct }
  }

  function buildPunctualityBlock(empId) {
    const { total, punctual, late, pct } = calcPunctualityStats(empId)
    const pctColor = pct === null ? 'var(--text-light)'
      : pct >= 80 ? '#27AE60'
      : pct >= 60 ? 'var(--gold)'
      : 'var(--terracotta)'
    return total > 0
      ? `<div style="background:rgba(61,43,53,0.06);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:10px">
           <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--aubergine);margin-bottom:4px">Pünktlichkeits-Statistik für diesen Monat</div>
           <div style="font-size:0.9rem;font-weight:600;color:${pctColor}">${pct}% (${punctual} Tage pünktlich / ${late} Tage verspätet)</div>
         </div>`
      : `<div style="background:rgba(61,43,53,0.06);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:10px;font-size:0.82rem;color:var(--text-light)">Noch keine Einträge für diesen Monat.</div>`
  }

  function showEvaluateModal(employeeId) {
    const emp = employees.find(e => e.id === employeeId)
    if (!emp) return
    const latestSelfEval = evaluations
      .filter(e => e.employee_id === employeeId && e.is_self_assessment === true)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] ?? null
    const modal = ScoreModal({
      employee: emp, evaluatorId: user.id,
      latestEval:  latestSelfEval,
      isManager:   !!(user?.profile?.is_manager || user?.profile?.role === 'manager'),
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

  async function addEmployee(formData, selectedSkills = []) {
    const tempPassword = formData.password || Math.random().toString(36).slice(-8)

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email:    formData.email,
      password: tempPassword,
      options: {
        data: { full_name: formData.full_name, role: formData.role || 'employee' },
      },
    })
    if (authError) {
      console.error('auth.signUp fehlgeschlagen:', authError)
      throw authError
    }

    const { error: profileError } = await supabase.from('profiles').insert({
      id:               authData.user.id,
      full_name:        formData.full_name,
      email:            formData.email,
      role:             formData.role || 'employee',
      assigned_studios: formData.assigned_studios ?? [],
      level:            formData.level || 'junior',
      skills:           selectedSkills,
    })
    if (profileError) {
      console.error('profiles INSERT fehlgeschlagen:', profileError)
      throw profileError
    }

    if (selectedSkills.length > 0) {
      const { error: skillError } = await supabase.from('employee_skills')
        .insert(selectedSkills.map(sid => ({ employee_id: authData.user.id, skill_id: sid })))
      if (skillError) console.warn('employee_skills INSERT fehlgeschlagen:', skillError)
    }
  }

  async function openSkillEditModal(empId) {
    const emp = employees.find(e => e.id === empId)
    if (!emp) return
    const skillsToShow    = availableSkills.length ? availableSkills : DEFAULT_SKILLS
    const currentSkillIds = new Set(employeeSkillsMap[empId] ?? emp.skills ?? [])

    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:16px;box-sizing:border-box'

    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:480px;width:100%;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:18px 20px 0;flex-shrink:0">
          <div>
            <h3 style="margin:0;font-size:1.05rem;color:var(--aubergine)">Skills zuweisen</h3>
            <div style="font-size:0.78rem;color:var(--text-light);margin-top:2px">${emp.full_name}</div>
          </div>
          <button id="sk-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-light);line-height:1;padding:4px">✕</button>
        </div>
        <div style="flex:1;overflow-y:auto;padding:16px 20px">
          <p style="font-size:0.8rem;color:var(--text-mid);margin-bottom:14px">Tippen zum Aktivieren / Deaktivieren</p>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            ${skillsToShow.map(skill => {
              const active = currentSkillIds.has(skill.id)
              const c = skill.color || 'var(--aubergine)'
              return `<button type="button" class="skill-modal-btn" data-skill="${skill.id}" data-active="${active}"
                style="padding:5px 12px;border-radius:20px;border:2px solid ${active ? c : 'var(--cream-dark)'};background:${active ? c : 'var(--white)'};color:${active ? '#fff' : 'var(--text-mid)'};font-size:0.8rem;font-weight:${active ? '600' : '400'};cursor:pointer;transition:all 0.15s">
                ${skill.label}${active ? ' ✓' : ''}
              </button>`
            }).join('')}
          </div>
        </div>
        <div style="padding:14px 20px;flex-shrink:0;border-top:1px solid var(--cream-dark)">
          <button id="sk-save" class="btn btn-accent" style="width:100%;justify-content:center">Änderungen speichern</button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    overlay.querySelectorAll('.skill-modal-btn').forEach(btn => {
      const skill = skillsToShow.find(s => s.id === btn.dataset.skill)
      btn.addEventListener('click', () => {
        const active = btn.dataset.active !== 'true'
        btn.dataset.active = String(active)
        const c = skill?.color || 'var(--aubergine)'
        btn.style.borderColor = active ? c : 'var(--cream-dark)'
        btn.style.background  = active ? c : 'var(--white)'
        btn.style.color       = active ? '#fff' : 'var(--text-mid)'
        btn.style.fontWeight  = active ? '600' : '400'
        btn.textContent       = (skill?.label ?? btn.dataset.skill) + (active ? ' ✓' : '')
      })
    })

    overlay.querySelector('#sk-close').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

    overlay.querySelector('#sk-save').addEventListener('click', async () => {
      const saveBtn = overlay.querySelector('#sk-save')
      saveBtn.disabled = true; saveBtn.textContent = 'Speichern…'

      const newSkillIds = []
      overlay.querySelectorAll('.skill-modal-btn[data-active="true"]').forEach(b => newSkillIds.push(b.dataset.skill))

      const { error: delErr } = await supabase.from('employee_skills').delete().eq('employee_id', empId)
      if (delErr) {
        showToast('Fehler: ' + delErr.message, 'error')
        saveBtn.disabled = false; saveBtn.textContent = 'Änderungen speichern'
        return
      }

      if (newSkillIds.length > 0) {
        const { error: insErr } = await supabase.from('employee_skills')
          .insert(newSkillIds.map(sid => ({ employee_id: empId, skill_id: sid })))
        if (insErr) {
          showToast('Fehler: ' + insErr.message, 'error')
          saveBtn.disabled = false; saveBtn.textContent = 'Änderungen speichern'
          return
        }
      }

      await supabase.from('profiles').update({ skills: newSkillIds }).eq('id', empId)
      showToast('Skills aktualisiert!', 'success')
      overlay.remove()
      await loadData()
      rerender()
    })
  }

  // ── Appointments ───────────────────────────────────────────────────────────

  function buildAppointmentsPanel(emp) {
    const appts      = appointmentsMap[emp.id] ?? []
    const empReqs    = appts.filter(a => a.status === 'pending_manager'  && a.initiated_by === emp.id)
    const mgrPending = appts.filter(a => a.status === 'pending_employee' && a.initiated_by !== emp.id)
    const active     = appts.filter(a => a.status === 'confirmed' && !a.is_signed_off)
    const archived   = appts.filter(a => a.status === 'confirmed' && a.is_signed_off)
    const isEmpty    = !empReqs.length && !mgrPending.length && !active.length && !archived.length
    const fmtDate    = d => { if (!d) return '–'; const dt = new Date(d); return isNaN(dt) ? '–' : dt.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' }) }
    const fmtTime    = d => { if (!d) return null; const dt = new Date(d); if (isNaN(dt)) return null; const h = dt.getHours(), m = dt.getMinutes(); if (!h && !m) return null; return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ' Uhr' }

    return `
      <div class="card" style="margin-bottom:20px">
        <div class="card-header">
          <h4>📅 Termine & Gespräche</h4>
          <button class="btn btn-ghost btn-sm" id="btn-new-mgr-appt" data-emp="${emp.id}">+ Termin anlegen</button>
        </div>

        ${empReqs.length > 0 ? `
          <div style="padding:12px 16px 4px">
            <div style="font-size:0.7rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--terracotta);margin-bottom:8px">Anfragen vom Mitarbeiter</div>
            ${empReqs.map(a => `
              <div style="padding:10px 0;border-bottom:1px solid var(--cream-dark);display:flex;justify-content:space-between;align-items:center;gap:10px">
                <div>
                  <div style="font-weight:600;font-size:0.9rem;color:var(--aubergine)">${fmtDate(a.scheduled_date)}${fmtTime(a.scheduled_date) ? ' · ' + fmtTime(a.scheduled_date) : ''}</div>
                  ${a.note ? `<div style="font-size:0.78rem;color:var(--text-mid)">${a.note}</div>` : ''}
                </div>
                <button class="btn-confirm-emp-req" data-id="${a.id}" style="background:#27AE60;color:#fff;border:none;border-radius:var(--radius-sm);padding:5px 12px;font-size:0.8rem;cursor:pointer;font-weight:600;flex-shrink:0">✓ Bestätigen</button>
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${mgrPending.length > 0 ? `
          <div style="padding:12px 16px 4px">
            <div style="font-size:0.7rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--gold);margin-bottom:8px">Gesendete Einladungen · Ausstehend</div>
            ${mgrPending.map(a => `
              <div style="padding:8px 0;border-bottom:1px solid var(--cream-dark);display:flex;justify-content:space-between;align-items:center;gap:10px">
                <div>
                  <div style="font-weight:600;font-size:0.85rem;color:var(--aubergine)">${fmtDate(a.scheduled_date)}${fmtTime(a.scheduled_date) ? ' · ' + fmtTime(a.scheduled_date) : ''}</div>
                  <div style="font-size:0.78rem;color:var(--text-mid)">${a.type === 'online' ? '🌐 Online' : '📍 ' + locationLabel(a.location)}</div>
                </div>
                <span style="font-size:0.72rem;color:var(--gold);background:rgba(212,162,66,0.12);padding:3px 8px;border-radius:var(--radius-sm);white-space:nowrap">Ausstehend</span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${active.length > 0 ? `
          <div style="padding:12px 16px 4px">
            <div style="font-size:0.7rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#27AE60;margin-bottom:8px">🗓️ Anstehende Termine</div>
            ${active.map(a => `
              <div style="padding:10px 0;border-bottom:1px solid var(--cream)">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
                  <div>
                    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                      <div style="font-weight:600;font-size:0.9rem;color:var(--aubergine)">${fmtDate(a.scheduled_date)}${fmtTime(a.scheduled_date) ? ' · ' + fmtTime(a.scheduled_date) : ''}</div>
                      ${a.protocol_text
                        ? `<span style="font-size:0.7rem;font-weight:700;color:#DC2626;background:#FEE2E2;padding:2px 8px;border-radius:var(--radius-sm);white-space:nowrap;border:1px solid #FECACA">❗ Lesebestätigung steht aus</span>`
                        : `<span style="font-size:0.7rem;color:var(--text-light);background:var(--cream-dark);padding:2px 7px;border-radius:var(--radius-sm);white-space:nowrap">Protokoll ausstehend</span>`
                      }
                    </div>
                    <div style="font-size:0.78rem;color:var(--text-mid)">${a.type === 'online' ? '🌐 Online' : '📍 ' + locationLabel(a.location)}</div>
                    ${a.note ? `<div style="font-size:0.75rem;color:var(--text-light)">${a.note}</div>` : ''}
                  </div>
                  ${a.type === 'online' && a.meet_link ? `
                    <a href="${a.meet_link}" target="_blank" rel="noopener" style="background:#1a73e8;color:#fff;border-radius:var(--radius-sm);padding:5px 10px;font-size:0.78rem;font-weight:600;text-decoration:none;white-space:nowrap;flex-shrink:0">📹 Meet</a>
                  ` : ''}
                </div>
                <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
                  ${buildPunctualityBlock(emp.id)}
                  <label style="font-size:0.8rem;font-weight:600;color:var(--text-mid)">Gesprächsprotokoll / Fazit</label>
                  <textarea class="appt-protocol-ta" data-id="${a.id}" rows="3"
                    placeholder="Gesprächsprotokoll, Vereinbarungen, nächste Schritte..."
                    style="width:100%;padding:8px 10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.82rem;resize:vertical;font-family:inherit;box-sizing:border-box">${a.protocol_text || ''}</textarea>
                  <label style="font-size:0.8rem;font-weight:600;color:var(--text-mid)">Meeting-Transkript (optional)</label>
                  <textarea class="appt-transcript-ta" data-id="${a.id}" rows="3"
                    placeholder="Google Meet Transkript oder Notizen hier einfügen..."
                    style="width:100%;padding:8px 10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.82rem;resize:vertical;font-family:inherit;box-sizing:border-box">${a.transcript_text || ''}</textarea>
                  <button class="btn-save-protocol" data-id="${a.id}"
                    style="align-self:flex-start;padding:7px 18px;background:var(--aubergine);color:#fff;border:none;border-radius:var(--radius-sm);font-size:0.82rem;font-weight:600;cursor:pointer">
                    Protokoll speichern
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${archived.length > 0 ? `
          <div style="padding:10px 16px 4px">
            <div style="font-size:0.7rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-light);margin-bottom:6px">📂 Gesprächshistorie</div>
            <div style="${archived.length > 3 ? 'max-height:180px;overflow-y:auto;' : ''}">
              ${archived.map(a => {
                const fmtDt = d => { if (!d) return '–'; const dt = new Date(d); if (isNaN(dt)) return '–'; const h = dt.getHours(), m = dt.getMinutes(); const time = (!h && !m) ? '' : ' · ' + String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0'); return dt.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric', year: '2-digit' }) + time }
                return `
                <div style="padding:5px 0;border-bottom:1px solid var(--cream);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <span style="font-size:0.75rem;color:var(--text-light);flex-shrink:0">${fmtDt(a.scheduled_date)}</span>
                  ${a.note ? `<span style="font-size:0.75rem;color:var(--text-mid);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${a.note}</span>` : '<span style="flex:1"></span>'}
                  <button class="btn-view-protocol" data-id="${a.id}"
                    style="flex-shrink:0;padding:3px 9px;background:var(--cream-dark);border:none;border-radius:var(--radius-sm);font-size:0.72rem;cursor:pointer;white-space:nowrap">
                    📋 Protokoll ansehen
                  </button>
                </div>
              `}).join('')}
            </div>
          </div>
        ` : ''}

        ${isEmpty ? `
          <div class="empty-state" style="padding:20px">
            <span class="empty-state-icon" style="font-size:1.5rem">📅</span>
            <p>Noch keine Termine für ${emp.full_name}.</p>
          </div>
        ` : '<div style="height:4px"></div>'}
      </div>
    `
  }

  function buildManagerScheduleCard(emp) {
    const today = localDate()
    return `
      <div class="card" style="margin-bottom:20px;border-left:4px solid var(--aubergine)">
        <div class="card-header" style="margin-bottom:4px">
          <h4>📅 Performance-Gespräch ansetzen</h4>
        </div>
        <div style="display:flex;flex-direction:column;gap:14px">
          ${buildPunctualityBlock(emp.id)}
          <div>
            <div style="font-size:0.8rem;font-weight:700;color:var(--text-mid);margin-bottom:6px">Format</div>
            <div style="display:flex;gap:8px">
              <button type="button" id="msc-type-offline" data-emp="${emp.id}"
                style="flex:1;padding:9px 12px;border:2px solid var(--aubergine);border-radius:var(--radius-sm);background:var(--aubergine);color:#fff;font-weight:600;font-size:0.85rem;cursor:pointer">
                📍 Offline
              </button>
              <button type="button" id="msc-type-online" data-emp="${emp.id}"
                style="flex:1;padding:9px 12px;border:2px solid var(--cream-dark);border-radius:var(--radius-sm);background:var(--white);color:var(--text-mid);font-size:0.85rem;cursor:pointer">
                🌐 Online
              </button>
            </div>
          </div>
          <div id="msc-field-location">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
              Standort
              <select id="msc-location" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;background:var(--white);color:var(--aubergine)">
                <option value="mitte">Studio Mitte</option>
                <option value="kadewe">KaDeWe</option>
              </select>
            </label>
          </div>
          <div id="msc-field-meet" style="display:none">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
              Google Meet Link
              <input id="msc-meet" type="url" value="https://meet.google.com/evk-uwqn-erb" placeholder="https://meet.google.com/..."
                style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.85rem;color:var(--aubergine)">
            </label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
              Datum
              <input id="msc-date" type="date" min="${today}" value="${today}"
                style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;color:var(--aubergine)">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
              Uhrzeit
              <select id="msc-time" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;color:var(--aubergine);background:var(--white)">
                ${buildTimeOptions()}
              </select>
            </label>
          </div>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Notiz (optional)
            <textarea id="msc-note" rows="2" placeholder="Thema des Gesprächs, Vorbereitungshinweise..."
              style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.85rem;resize:none;font-family:inherit"></textarea>
          </label>
          <button id="msc-submit" class="btn btn-accent" data-emp="${emp.id}"
            style="width:100%;justify-content:center;padding:14px;font-size:0.88rem;font-weight:700;letter-spacing:0.02em">
            📅 + TERMIN VERBINDLICH EINTRAGEN
          </button>
        </div>
      </div>
    `
  }

  function openConfirmAppointmentModal(apptId) {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:16px;box-sizing:border-box'
    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:360px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:18px 20px 0">
          <h3 style="margin:0;font-size:1.05rem;color:var(--aubergine)">Termin bestätigen</h3>
          <button id="ca-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-light);line-height:1;padding:4px">✕</button>
        </div>
        <div style="padding:16px 20px;display:flex;flex-direction:column;gap:14px">
          <p style="font-size:0.85rem;color:var(--text-mid);margin:0">Wähle das Format für diesen Termin:</p>
          <div style="display:flex;gap:8px">
            <button type="button" id="ca-type-offline"
              style="flex:1;padding:9px;border:2px solid var(--aubergine);border-radius:var(--radius-sm);background:var(--aubergine);color:#fff;font-weight:600;font-size:0.85rem;cursor:pointer">
              📍 Offline
            </button>
            <button type="button" id="ca-type-online"
              style="flex:1;padding:9px;border:2px solid var(--cream-dark);border-radius:var(--radius-sm);background:var(--white);color:var(--text-mid);font-size:0.85rem;cursor:pointer">
              🌐 Online
            </button>
          </div>
          <div id="ca-field-location">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
              Standort
              <select id="ca-location" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;background:var(--white);color:var(--aubergine)">
                <option value="mitte">Studio Mitte</option>
                <option value="kadewe">KaDeWe</option>
              </select>
            </label>
          </div>
          <div id="ca-field-meet" style="display:none">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
              Google Meet Link
              <input id="ca-meet" type="url" value="https://meet.google.com/evk-uwqn-erb"
                placeholder="https://meet.google.com/..."
                style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.85rem;color:var(--aubergine)">
            </label>
          </div>
        </div>
        <div style="padding:0 20px 20px">
          <button id="ca-save" class="btn btn-accent" style="width:100%;justify-content:center">✓ Termin verbindlich bestätigen</button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    let selectedType = 'offline'
    const offlineBtn = overlay.querySelector('#ca-type-offline')
    const onlineBtn  = overlay.querySelector('#ca-type-online')
    const fieldLoc   = overlay.querySelector('#ca-field-location')
    const fieldMeet  = overlay.querySelector('#ca-field-meet')

    function setCaType(t) {
      selectedType = t
      const onBtn  = t === 'offline' ? offlineBtn : onlineBtn
      const offBtn = t === 'offline' ? onlineBtn  : offlineBtn
      onBtn.style.borderColor  = 'var(--aubergine)'; onBtn.style.background = 'var(--aubergine)'; onBtn.style.color = '#fff'; onBtn.style.fontWeight = '600'
      offBtn.style.borderColor = 'var(--cream-dark)'; offBtn.style.background = 'var(--white)'; offBtn.style.color = 'var(--text-mid)'; offBtn.style.fontWeight = '400'
      fieldLoc.style.display  = t === 'offline' ? '' : 'none'
      fieldMeet.style.display = t === 'online'  ? '' : 'none'
    }

    offlineBtn.addEventListener('click', () => setCaType('offline'))
    onlineBtn.addEventListener('click',  () => setCaType('online'))
    overlay.querySelector('#ca-close').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

    overlay.querySelector('#ca-save').addEventListener('click', async () => {
      const location = selectedType === 'offline' ? (overlay.querySelector('#ca-location').value || null) : null
      const meetLink = selectedType === 'online'  ? (overlay.querySelector('#ca-meet').value.trim() || null) : null

      if (selectedType === 'online' && !meetLink) { showToast('Bitte gib einen Google Meet Link ein.', 'error'); return }

      const btn = overlay.querySelector('#ca-save')
      btn.disabled = true; btn.textContent = 'Speichern...'

      const { error } = await supabase.from('manager_appointments')
        .update({ status: 'confirmed', manager_id: user.id, type: selectedType, location, meet_link: meetLink })
        .eq('id', apptId)

      if (error) {
        showToast('Fehler: ' + error.message, 'error')
        btn.disabled = false; btn.textContent = '✓ Termin verbindlich bestätigen'
        return
      }
      showToast('Termin bestätigt!')
      overlay.remove()
      await loadData(); rerender()
    })
  }

  function openManagerAppointmentModal(empId) {
    const emp   = employees.find(e => e.id === empId)
    const today = localDate()

    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:16px;box-sizing:border-box'
    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:18px 20px 0">
          <div>
            <h3 style="margin:0;font-size:1.05rem;color:var(--aubergine)">Termin anlegen</h3>
            <div style="font-size:0.78rem;color:var(--text-light);margin-top:2px">${emp?.full_name ?? '–'}</div>
          </div>
          <button id="ma-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-light);line-height:1;padding:4px">✕</button>
        </div>
        <div style="padding:16px 20px;display:flex;flex-direction:column;gap:14px">
          <div>
            <div style="font-size:0.85rem;color:var(--text-mid);margin-bottom:6px">Format</div>
            <div style="display:flex;gap:8px">
              <button type="button" id="ma-type-offline" style="flex:1;padding:8px;border:2px solid var(--aubergine);border-radius:var(--radius-sm);background:var(--aubergine);color:#fff;font-weight:600;font-size:0.85rem;cursor:pointer">📍 Offline</button>
              <button type="button" id="ma-type-online"  style="flex:1;padding:8px;border:2px solid var(--cream-dark);border-radius:var(--radius-sm);background:var(--white);color:var(--text-mid);font-size:0.85rem;cursor:pointer">🌐 Online</button>
            </div>
          </div>
          <div id="ma-field-location">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
              Standort
              <select id="ma-location" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;background:var(--white);color:var(--aubergine)">
                <option value="mitte">Studio Mitte</option>
                <option value="kadewe">KaDeWe</option>
              </select>
            </label>
          </div>
          <div id="ma-field-meet" style="display:none">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
              Google Meet Link
              <input id="ma-meet" type="url" value="https://meet.google.com/evk-uwqn-erb" placeholder="https://meet.google.com/..." style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.85rem;color:var(--aubergine)">
            </label>
          </div>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Datum
            <input id="ma-date" type="date" min="${today}" value="${today}" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.95rem;color:var(--aubergine)">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Uhrzeit
            <select id="ma-time" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;color:var(--aubergine);background:var(--white)">
              ${buildTimeOptions()}
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Notiz (optional)
            <textarea id="ma-note" rows="2" placeholder="Thema des Gesprächs..." style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.85rem;resize:none;font-family:inherit"></textarea>
          </label>
        </div>
        <div style="padding:0 20px 20px">
          <button id="ma-save" class="btn btn-accent" style="width:100%;justify-content:center">Einladung senden</button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    let selectedType = 'offline'
    const offlineBtn  = overlay.querySelector('#ma-type-offline')
    const onlineBtn   = overlay.querySelector('#ma-type-online')
    const fieldLoc    = overlay.querySelector('#ma-field-location')
    const fieldMeet   = overlay.querySelector('#ma-field-meet')

    function setType(t) {
      selectedType = t
      const onBtn  = t === 'offline' ? offlineBtn : onlineBtn
      const offBtn = t === 'offline' ? onlineBtn  : offlineBtn
      onBtn.style.borderColor  = 'var(--aubergine)'; onBtn.style.background  = 'var(--aubergine)'; onBtn.style.color  = '#fff'; onBtn.style.fontWeight  = '600'
      offBtn.style.borderColor = 'var(--cream-dark)'; offBtn.style.background = 'var(--white)'; offBtn.style.color = 'var(--text-mid)'; offBtn.style.fontWeight = '400'
      fieldLoc.style.display  = t === 'offline' ? '' : 'none'
      fieldMeet.style.display = t === 'online'  ? '' : 'none'
    }

    offlineBtn.addEventListener('click', () => setType('offline'))
    onlineBtn.addEventListener('click',  () => setType('online'))
    overlay.querySelector('#ma-close').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

    overlay.querySelector('#ma-save').addEventListener('click', async () => {
      const date     = overlay.querySelector('#ma-date').value
      const time     = overlay.querySelector('#ma-time').value || null
      const note     = overlay.querySelector('#ma-note').value.trim() || null
      const location = selectedType === 'offline' ? (overlay.querySelector('#ma-location').value || null) : null
      const meetLink = selectedType === 'online'  ? (overlay.querySelector('#ma-meet').value.trim() || null) : null

      if (!date) { alert('Bitte wähle ein Datum.'); return }
      if (selectedType === 'online' && !meetLink) { alert('Bitte gib einen Google Meet Link ein.'); return }

      const btn = overlay.querySelector('#ma-save')
      btn.disabled = true; btn.textContent = 'Senden...'

      const { error } = await supabase.from('manager_appointments').insert({
        employee_id:    empId,
        manager_id:     user.id,
        scheduled_date: time ? `${date}T${time}:00` : date,
        type:           selectedType,
        location,
        meet_link:      meetLink,
        note:           note || null,
        status:         'confirmed',
        initiated_by:   user.id,
      })

      if (error) {
        showToast('Fehler: ' + error.message, 'error')
        btn.disabled = false; btn.textContent = 'Einladung senden'
        return
      }
      showToast('Termin verbindlich eingetragen!')
      overlay.remove()
      await loadData()
      rerender()
    })
  }

  // ── HTML builders ──────────────────────────────────────────────────────────

  function buildSkillManager(emp) {
    const allSkills = availableSkills.length ? availableSkills : getAllKnownSkills()
    const empSkills = employeeSkillsMap[emp.id] ?? emp.skills ?? []

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
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <button class="btn btn-ghost btn-sm" id="back-to-list">← Zurück</button>
        <h3 style="color:var(--aubergine)">${emp.full_name}</h3>
        <span class="badge ${emp.level === 'senior' ? 'badge-aubergine' : 'badge-gold'}">${emp.level}</span>
        <span class="badge badge-neutral">${locationLabel(emp.location)}</span>
        ${promotion.eligible ? `<span class="badge badge-success">⬆ Promotion-Ready</span>` : ''}
        ${piResult?.vetoAusgeloest ? `<span class="badge" style="background:var(--terracotta);color:#fff">⚠ Safety Veto</span>` : ''}
      </div>

      ${buildManagerScheduleCard(emp)}

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

      ${buildAppointmentsPanel(emp)}

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
              <label class="form-label">Studios *</label>
              <div style="display:flex;gap:20px;margin-top:6px">
                <label style="display:flex;align-items:center;gap:6px;font-size:0.9rem;cursor:pointer">
                  <input type="checkbox" name="studio_kadewe" style="width:15px;height:15px;accent-color:var(--aubergine)"> KaDeWe
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-size:0.9rem;cursor:pointer">
                  <input type="checkbox" name="studio_mitte" style="width:15px;height:15px;accent-color:var(--aubergine)"> Studio Mitte
                </label>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Level</label>
              <select class="form-select" name="level">
                <option value="junior">Junior</option>
                <option value="senior">Senior</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">System-Rolle *</label>
              <select class="form-select" name="role">
                <option value="employee">Employee</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>
          <div style="margin-top:20px">
            <label class="form-label" style="display:block;margin-bottom:10px">Zugeordnete Skills / Zertifizierungen</label>
            <div id="new-emp-skills-grid" style="display:flex;flex-wrap:wrap;gap:8px">
              ${(availableSkills.length ? availableSkills : DEFAULT_SKILLS).map(skill => `
                <button type="button" class="new-emp-skill-btn" data-skill="${skill.id}" data-active="false"
                  style="padding:6px 14px;border-radius:20px;border:2px solid var(--cream-dark);background:var(--white);
                    color:var(--text-mid);font-size:0.8rem;cursor:pointer;transition:all 0.15s">
                  ${skill.label}
                </button>
              `).join('')}
            </div>
            <p style="font-size:0.72rem;color:var(--text-light);margin-top:8px">Tippe auf Skills zum Auswählen.</p>
          </div>
          <button type="submit" class="btn btn-primary" id="add-submit-btn" style="margin-top:20px">Mitarbeiter anlegen</button>
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

  function openHistoricalCorrectionModal(empId) {
    const emp        = employees.find(e => e.id === empId)
    const HOUR_OPTS  = Array.from({ length: 13 }, (_, i) => i)
    const MIN_OPTS   = [0, 15, 30, 45]
    const selectStyle = 'padding:10px 8px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:1rem;font-weight:700;color:var(--aubergine);background:var(--white);text-align:center;-webkit-appearance:auto;cursor:pointer;width:100%'

    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:16px;box-sizing:border-box'

    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:360px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:18px 20px 0">
          <div>
            <h3 style="margin:0;font-size:1.05rem;color:var(--aubergine)">Zeiten korrigieren</h3>
            <div style="font-size:0.78rem;color:var(--text-light);margin-top:2px">${emp?.full_name ?? '–'}</div>
          </div>
          <button id="hc-close" style="background:none;border:none;font-size:0.85rem;cursor:pointer;color:var(--text-light);padding:4px 8px;font-weight:700">X</button>
        </div>
        <div style="padding:16px 20px;display:flex;flex-direction:column;gap:14px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Datum der Schicht
            <input id="hc-date" type="date" max="${localDate()}"
              style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:1rem;color:var(--aubergine);background:var(--white)">
          </label>
          <div>
            <div style="font-size:0.85rem;font-weight:600;color:var(--text-mid);margin-bottom:8px">Neue Netto-Arbeitszeit</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div style="display:flex;flex-direction:column;gap:4px">
                <span style="font-size:0.75rem;color:var(--text-light);text-align:center">Stunden</span>
                <select id="hc-hours" style="${selectStyle}">
                  ${HOUR_OPTS.map(h => `<option value="${h}">${h} Std.</option>`).join('')}
                </select>
              </div>
              <div style="display:flex;flex-direction:column;gap:4px">
                <span style="font-size:0.75rem;color:var(--text-light);text-align:center">Minuten</span>
                <select id="hc-mins" style="${selectStyle}">
                  ${MIN_OPTS.map(m => `<option value="${m}">${String(m).padStart(2,'0')} Min.</option>`).join('')}
                </select>
              </div>
            </div>
          </div>
        </div>
        <div style="padding:0 20px 20px;display:flex;gap:8px">
          <button id="hc-cancel" class="btn btn-ghost" style="flex:1;justify-content:center">[ Abbrechen ]</button>
          <button id="hc-save" class="btn btn-accent" style="flex:1;justify-content:center">[ Speichern ]</button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    overlay.querySelector('#hc-close').addEventListener('click', () => overlay.remove())
    overlay.querySelector('#hc-cancel').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

    overlay.querySelector('#hc-save').addEventListener('click', async () => {
      const dateVal = overlay.querySelector('#hc-date').value
      if (!dateVal) { showToast('Bitte ein Datum auswaehlen.', 'error'); return }
      const h    = parseInt(overlay.querySelector('#hc-hours').value, 10)
      const m    = parseInt(overlay.querySelector('#hc-mins').value,  10)
      const netH = h + m / 60
      if (netH <= 0) { showToast('Bitte eine Arbeitszeit von mindestens 15 Minuten angeben.', 'error'); return }

      const saveBtn = overlay.querySelector('#hc-save')
      saveBtn.disabled    = true
      saveBtn.textContent = 'Wird gespeichert...'

      const { error } = await supabase
        .from('employee_daily_hours')
        .upsert({
          employee_id:   empId,
          date:          dateVal,
          hours_worked:  netH,
          break_minutes: 0,
          location_id:   emp?.location_id ?? null,
          is_modified:   true,
        }, { onConflict: 'employee_id,date' })

      if (error) {
        showToast('Fehler: ' + error.message, 'error')
        saveBtn.disabled    = false
        saveBtn.textContent = '[ Speichern ]'
        return
      }

      showToast(`Arbeitszeit fuer ${emp?.full_name ?? '–'} gespeichert.`)
      overlay.remove()
      await loadData()
      rerender()
    })
  }

  function openTargetHoursModal(empId) {
    const now  = new Date()
    const year  = now.getFullYear()
    const month = now.getMonth() + 1
    const emp   = employees.find(e => e.id === empId)
    const cur   = Number(monthlyTargets.find(t => t.employee_id === empId)?.target_hours ?? 160)

    const overlay = document.createElement('div')
    overlay.style.position       = 'fixed'
    overlay.style.top            = '0'
    overlay.style.left           = '0'
    overlay.style.width          = '100vw'
    overlay.style.height         = '100vh'
    overlay.style.zIndex         = '9999'
    overlay.style.display        = 'flex'
    overlay.style.alignItems     = 'center'
    overlay.style.justifyContent = 'center'
    overlay.style.background     = 'rgba(0,0,0,0.55)'
    overlay.style.padding        = '16px'
    overlay.style.boxSizing      = 'border-box'

    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:340px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:18px 20px 0">
          <div>
            <h3 style="margin:0;font-size:1.05rem;color:var(--aubergine)">Soll-Stunden festlegen</h3>
            <div style="font-size:0.78rem;color:var(--text-light);margin-top:2px">${emp?.full_name ?? '–'} · ${month}/${year}</div>
          </div>
          <button id="at-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-light);line-height:1;padding:4px">✕</button>
        </div>
        <div style="padding:16px 20px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Monatliches Stunden-Soll
            <input id="at-target" type="number" min="0" max="300" step="4" value="${cur}"
              style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:1.2rem;font-weight:700;text-align:center;margin-top:4px">
          </label>
        </div>
        <div style="padding:0 20px 20px">
          <button id="at-save" class="btn btn-accent" style="width:100%;justify-content:center">Speichern</button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)
    overlay.querySelector('#at-close').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

    overlay.querySelector('#at-save').addEventListener('click', async () => {
      const target  = Math.max(0, parseFloat(overlay.querySelector('#at-target').value) || 0)
      const saveBtn = overlay.querySelector('#at-save')
      saveBtn.disabled = true; saveBtn.textContent = 'Speichern...'

      const { error } = await supabase
        .from('employee_monthly_targets')
        .upsert({ employee_id: empId, year, month, target_hours: target },
                { onConflict: 'employee_id,year,month' })

      if (error) {
        showToast('Fehler: ' + error.message, 'error')
        saveBtn.disabled = false; saveBtn.textContent = 'Speichern'
        return
      }
      showToast(`Soll-Stunden für ${emp?.full_name ?? '–'} gespeichert.`)
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
      const empH           = employeeHours.filter(h => h.employee_id === emp.id)
      const netMins        = (filter) => empH.filter(filter).reduce((s, h) => s + Math.max(0, h.hours_worked * 60 - h.break_minutes), 0)
      const targetH        = Number(monthlyTargets.find(t => t.employee_id === emp.id)?.target_hours ?? 160)
      const monthMins      = netMins(() => true)
      const monthH         = monthMins / 60
      const balance        = monthH - targetH
      const modifiedEntries = empH.filter(h => h.is_modified)
      return {
        emp, targetH, balance,
        todayMins: netMins(h => h.date === today),
        weekMins:  netMins(h => h.date >= weekStart),
        monthMins,
        modifiedEntries,
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
                <th>Soll</th>
                <th>Konto (+/−)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(({ emp, todayMins, weekMins, monthMins, targetH, balance, modifiedEntries }) => {
                const balStr   = (balance >= 0 ? '+' : '') + balance.toFixed(1) + ' Std.'
                const balColor = balance >= 0 ? '#27AE60' : 'var(--terracotta)'

                let warnBadge = ''
                if (modifiedEntries.length > 0) {
                  const tooltipLines = modifiedEntries.map(h => {
                    const d  = new Date(h.date + 'T12:00:00').toLocaleDateString('de-DE', { day: 'numeric', month: '2-digit' })
                    const oh = h.original_hours ?? '?'
                    const nh = Math.floor(h.hours_worked) + ' Std. ' + Math.round((h.hours_worked % 1) * 60) + ' Min.'
                    return `${d}: Original: ${oh} | Geändert: ${nh}`
                  }).join('\n')
                  warnBadge = `<span class="mod-warn-badge" data-tooltip="Auffälligkeit: Arbeitszeit manuell geändert&#10;${tooltipLines.replace(/"/g,'&quot;')}" style="cursor:help;background:#FEF9C3;color:#92400E;border-radius:4px;padding:1px 6px;font-size:0.75rem;font-weight:700;border:1px solid #FDE68A;flex-shrink:0">⚠</span>`
                }

                return `
                <tr class="hours-row" data-emp="${emp.id}" style="cursor:pointer" title="Klicken zum Tages-Eintrag bearbeiten">
                  <td>
                    <div style="display:flex;align-items:center;gap:8px">
                      <div>
                        <div style="display:flex;align-items:center;gap:5px;font-weight:500">${emp.full_name}${warnBadge}</div>
                        <div style="font-size:0.72rem;color:var(--text-light)">${locationLabel(emp.location)}</div>
                      </div>
                      <button class="btn-edit-target btn btn-ghost btn-sm" data-emp="${emp.id}"
                        style="padding:2px 7px;font-size:0.7rem;line-height:1.6"
                        title="Soll-Stunden bearbeiten">✏</button>
                      <button class="btn-edit-skills btn btn-ghost btn-sm" data-emp="${emp.id}"
                        style="padding:2px 7px;font-size:0.7rem;line-height:1.6"
                        title="Skills bearbeiten">Skills</button>
                    </div>
                  </td>
                  <td style="font-weight:600;color:var(--aubergine)">${fmtHours(todayMins)}</td>
                  <td>${fmtHours(weekMins)}</td>
                  <td style="font-weight:600;color:var(--aubergine)">${fmtHours(monthMins)}</td>
                  <td style="color:var(--text-mid)">${targetH} Std.</td>
                  <td style="font-weight:700;color:${balColor}">${monthMins > 0 || balance < 0 ? balStr : '–'}</td>
                  <td>
                    <button class="btn-correct-hours btn btn-ghost btn-sm" data-emp="${emp.id}"
                      style="white-space:nowrap;font-size:0.72rem;padding:3px 8px"
                      title="Historische Schicht manuell eintragen oder korrigieren">[ Zeiten korrigieren ]</button>
                  </td>
                </tr>
              `}).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `
  }

  function buildPendingAppointmentsPanel() {
    const pending = allAppointments.filter(a => a.status === 'pending_manager')
    if (!pending.length) return ''

    const fmtDate = d => { if (!d) return '–'; const dt = new Date(d); return isNaN(dt) ? '–' : dt.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' }) }
    const fmtTime = d => { if (!d) return null; const dt = new Date(d); if (isNaN(dt)) return null; const h = dt.getHours(), m = dt.getMinutes(); if (!h && !m) return null; return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ' Uhr' }

    return `
      <div class="card" style="margin-bottom:24px;border-left:4px solid var(--terracotta)">
        <div class="card-header">
          <h4>📅 Eingegangene Terminanfragen</h4>
          <span style="font-size:0.78rem;font-weight:700;color:var(--terracotta)">${pending.length} offen</span>
        </div>
        <div style="padding:0 16px">
          ${pending.map(a => {
            const emp = employees.find(e => e.id === a.employee_id)
            return `
              <div style="padding:12px 0;border-bottom:1px solid var(--cream-dark);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
                <div>
                  <div style="font-weight:600;font-size:0.9rem;color:var(--aubergine)">${emp?.full_name ?? '–'}</div>
                  <div style="font-size:0.8rem;color:var(--text-mid)">📅 ${fmtDate(a.scheduled_date)}${fmtTime(a.scheduled_date) ? ' · ' + fmtTime(a.scheduled_date) : ''}</div>
                  ${a.note ? `<div style="font-size:0.75rem;color:var(--text-light);margin-top:2px">${a.note}</div>` : ''}
                </div>
                <div style="display:flex;gap:6px;flex-shrink:0">
                  <button class="btn-global-confirm-appt" data-id="${a.id}" style="background:#27AE60;color:#fff;border:none;border-radius:var(--radius-sm);padding:6px 14px;font-size:0.82rem;cursor:pointer;font-weight:600">✓ Bestätigen</button>
                  <button class="btn-global-decline-appt" data-id="${a.id}" style="background:var(--terracotta);color:#fff;border:none;border-radius:var(--radius-sm);padding:6px 12px;font-size:0.82rem;cursor:pointer">✕ Ablehnen</button>
                </div>
              </div>
            `
          }).join('')}
        </div>
      </div>
    `
  }

  function buildActiveAppointmentsPanel() {
    const active = allAppointments.filter(a => a.status === 'confirmed' && !a.is_signed_off)
    if (!active.length) return ''

    const fmtDate = d => { if (!d) return '–'; const dt = new Date(d); return isNaN(dt) ? '–' : dt.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' }) }
    const fmtTime = d => { if (!d) return null; const dt = new Date(d); if (isNaN(dt)) return null; const h = dt.getHours(), m = dt.getMinutes(); if (!h && !m) return null; return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ' Uhr' }

    return `
      <div class="card" style="margin-bottom:24px;border-left:4px solid #27AE60">
        <div class="card-header">
          <h4>🗓️ Anstehende Gesprächstermine</h4>
          <span style="font-size:0.78rem;font-weight:700;color:#27AE60">${active.length} aktiv</span>
        </div>
        <div style="padding:0 16px">
          ${active.map(a => {
            const emp = employees.find(e => e.id === a.employee_id)
            const signOffBadge = a.protocol_text
              ? `<span style="font-size:0.7rem;font-weight:700;color:#DC2626;background:#FEE2E2;padding:2px 8px;border-radius:var(--radius-sm);white-space:nowrap;border:1px solid #FECACA">❗ Lesebestätigung steht aus</span>`
              : `<span style="font-size:0.7rem;color:var(--text-light);background:var(--cream-dark);padding:2px 7px;border-radius:var(--radius-sm);white-space:nowrap">Protokoll ausstehend</span>`
            return `
              <div style="padding:12px 0;border-bottom:1px solid var(--cream-dark)">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
                  <div>
                    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                      <div style="font-weight:600;font-size:0.9rem;color:var(--aubergine)">${emp?.full_name ?? '–'}</div>
                      ${signOffBadge}
                    </div>
                    <div style="font-size:0.8rem;color:var(--text-mid);margin-top:2px">📅 ${fmtDate(a.scheduled_date)}${fmtTime(a.scheduled_date) ? ' um ' + fmtTime(a.scheduled_date) : ''} · ${a.type === 'online' ? '🌐 Online' : '📍 ' + locationLabel(a.location)}</div>
                    ${a.note ? `<div style="font-size:0.75rem;color:var(--text-light);margin-top:2px">${a.note}</div>` : ''}
                  </div>
                  ${a.type === 'online' && a.meet_link ? `
                    <a href="${a.meet_link}" target="_blank" rel="noopener" style="background:#1a73e8;color:#fff;border-radius:var(--radius-sm);padding:4px 10px;font-size:0.75rem;font-weight:600;text-decoration:none;white-space:nowrap;flex-shrink:0">📹 Meet beitreten</a>
                  ` : ''}
                </div>
                <div style="margin-top:10px;display:flex;flex-direction:column;gap:7px">
                  ${buildPunctualityBlock(a.employee_id)}
                  <label style="font-size:0.78rem;font-weight:600;color:var(--text-mid)">Gesprächsprotokoll & Fazit</label>
                  <textarea class="lsf-protocol-ta" data-id="${a.id}" rows="2"
                    placeholder="Gesprächsprotokoll, Vereinbarungen, nächste Schritte..."
                    style="width:100%;padding:7px 9px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.8rem;resize:vertical;font-family:inherit;box-sizing:border-box">${a.protocol_text || ''}</textarea>
                  <label style="font-size:0.78rem;font-weight:600;color:var(--text-mid)">Google Meet Transkript / Meeting-Notizen</label>
                  <textarea class="lsf-transcript-ta" data-id="${a.id}" rows="2"
                    placeholder="Transkript oder Notizen hier einfügen..."
                    style="width:100%;padding:7px 9px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.8rem;resize:vertical;font-family:inherit;box-sizing:border-box">${a.transcript_text || ''}</textarea>
                  <button class="lsf-save-protocol" data-id="${a.id}"
                    style="align-self:flex-start;padding:6px 16px;background:var(--aubergine);color:#fff;border:none;border-radius:var(--radius-sm);font-size:0.8rem;font-weight:600;cursor:pointer">
                    Protokoll speichern
                  </button>
                </div>
              </div>
            `
          }).join('')}
        </div>
      </div>
    `
  }

  function buildArchivedAppointmentsPanel() {
    const archived = allAppointments.filter(a => a.status === 'confirmed' && a.is_signed_off)
    if (!archived.length) return ''

    const fmtDt = d => {
      if (!d) return '–'
      const dt = new Date(d)
      if (isNaN(dt)) return '–'
      const h = dt.getHours(), m = dt.getMinutes()
      const time = (!h && !m) ? '' : ' um ' + String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0')
      return dt.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric', year: '2-digit' }) + time
    }

    const needsScroll = archived.length > 3

    return `
      <div class="card" style="margin-bottom:24px">
        <div class="card-header">
          <h4>📂 Gesprächshistorie</h4>
          <span style="font-size:0.78rem;color:var(--text-light)">${archived.length} archiviert</span>
        </div>
        <div style="${needsScroll ? 'max-height:220px;overflow-y:auto;' : ''}padding:0 16px">
          ${archived.map(a => {
            const emp = employees.find(e => e.id === a.employee_id)
            return `
              <div style="padding:7px 0;border-bottom:1px solid var(--cream);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <span style="font-size:0.78rem;color:var(--text-light);flex-shrink:0">${fmtDt(a.scheduled_date)}</span>
                <span style="font-size:0.82rem;font-weight:600;color:var(--aubergine)">${emp?.full_name ?? '–'}</span>
                <span style="font-size:0.7rem;color:#27AE60;font-weight:700;background:rgba(39,174,96,0.1);padding:1px 6px;border-radius:3px;flex-shrink:0;white-space:nowrap">✓ Bestätigt</span>
                ${a.note ? `<span style="font-size:0.75rem;color:var(--text-light);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${a.note}</span>` : '<span style="flex:1"></span>'}
                <button class="btn-view-protocol" data-id="${a.id}"
                  style="flex-shrink:0;padding:3px 10px;background:var(--cream-dark);border:none;border-radius:var(--radius-sm);font-size:0.75rem;cursor:pointer;white-space:nowrap">
                  📋 Protokoll ansehen
                </button>
              </div>
            `
          }).join('')}
        </div>
      </div>
    `
  }

  function openProtocolViewModal(apptId) {
    const a   = allAppointments.find(x => x.id === apptId)
    const emp = employees.find(e => e.id === a?.employee_id)
    if (!a) return

    const fmtDt = d => {
      if (!d) return '–'
      const dt = new Date(d)
      if (isNaN(dt)) return '–'
      const h = dt.getHours(), m = dt.getMinutes()
      const time = (!h && !m) ? '' : ' um ' + String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ' Uhr'
      return dt.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + time
    }

    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:16px;box-sizing:border-box'
    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:520px;width:100%;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:18px 20px 0;flex-shrink:0">
          <div>
            <h3 style="margin:0;font-size:1.05rem;color:var(--aubergine)">${emp?.full_name ?? '–'}</h3>
            <div style="font-size:0.78rem;color:var(--text-light);margin-top:2px">${fmtDt(a.scheduled_date)} · ${a.type === 'online' ? '🌐 Online' : '📍 ' + locationLabel(a.location)}</div>
          </div>
          <button id="pv-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-light);line-height:1;padding:4px">✕</button>
        </div>
        <div style="flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:16px">
          ${a.protocol_text ? `
            <div>
              <div style="font-size:0.72rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--aubergine);margin-bottom:6px">Gesprächsprotokoll & Fazit</div>
              <div style="font-size:0.88rem;color:var(--text-mid);white-space:pre-wrap;line-height:1.6;background:rgba(61,43,53,0.04);padding:10px 12px;border-radius:var(--radius-sm)">${a.protocol_text}</div>
            </div>
          ` : '<div style="font-size:0.85rem;color:var(--text-light)">Kein Protokoll vorhanden.</div>'}
          ${a.transcript_text ? `
            <div>
              <div style="font-size:0.72rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--aubergine);margin-bottom:6px">Meeting-Transkript</div>
              <div style="font-size:0.82rem;color:var(--text-mid);white-space:pre-wrap;line-height:1.5;font-family:monospace;background:rgba(61,43,53,0.04);padding:10px 12px;border-radius:var(--radius-sm);max-height:200px;overflow-y:auto">${a.transcript_text}</div>
            </div>
          ` : ''}
        </div>
        <div style="padding:0 20px 18px;flex-shrink:0">
          <div style="font-size:0.72rem;color:#27AE60;font-weight:600">✓ Mitarbeiter hat dieses Protokoll bestätigt</div>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    overlay.querySelector('#pv-close').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
  }

  function buildListScheduleForm() {
    const today      = localDate()
    const empOptions = employees.map(e => `<option value="${e.id}">${e.full_name}</option>`).join('')

    return `
      <div class="card" style="margin-bottom:24px;border-left:4px solid var(--aubergine)">
        <div class="card-header">
          <h4>📅 Feedback-Gespräch ansetzen</h4>
        </div>
        <div style="display:flex;flex-direction:column;gap:14px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
              Mitarbeiter
              <select id="lsf-employee" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;color:var(--aubergine);background:var(--white)">
                <option value="">– Mitarbeiter wählen –</option>
                ${empOptions}
              </select>
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
              Datum
              <input id="lsf-date" type="date" min="${today}" value="${today}"
                style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;color:var(--aubergine)">
            </label>
          </div>
          <div id="lsf-punctuality-preview"></div>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Uhrzeit
            <select id="lsf-time" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;color:var(--aubergine);background:var(--white)">
              ${buildTimeOptions()}
            </select>
          </label>
          <div>
            <div style="font-size:0.8rem;font-weight:700;color:var(--text-mid);margin-bottom:6px">Format</div>
            <div style="display:flex;gap:8px">
              <button type="button" id="lsf-type-offline"
                style="flex:1;padding:9px 12px;border:2px solid var(--aubergine);border-radius:var(--radius-sm);background:var(--aubergine);color:#fff;font-weight:600;font-size:0.85rem;cursor:pointer">
                📍 Offline
              </button>
              <button type="button" id="lsf-type-online"
                style="flex:1;padding:9px 12px;border:2px solid var(--cream-dark);border-radius:var(--radius-sm);background:var(--white);color:var(--text-mid);font-size:0.85rem;cursor:pointer">
                🌐 Online
              </button>
            </div>
          </div>
          <div id="lsf-field-location">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
              Standort
              <select id="lsf-location" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;background:var(--white);color:var(--aubergine)">
                <option value="kadewe">KaDeWe</option>
                <option value="mitte">Studio Mitte</option>
              </select>
            </label>
          </div>
          <div id="lsf-field-meet" style="display:none">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
              Google Meet Link
              <input id="lsf-meet" type="url" value="https://meet.google.com/evk-uwqn-erb"
                placeholder="https://meet.google.com/..."
                style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.85rem;color:var(--aubergine)">
            </label>
          </div>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Agenda-Notiz (optional)
            <textarea id="lsf-note" rows="2" placeholder="Gesprächsthema, Agenda-Punkte, Vorbereitung..."
              style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.85rem;resize:none;font-family:inherit"></textarea>
          </label>
          <button id="lsf-submit" class="btn btn-accent"
            style="width:100%;justify-content:center;padding:14px;font-size:0.9rem;font-weight:700;letter-spacing:0.02em">
            📅 + TERMIN VERBINDLICH EINTRAGEN
          </button>
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
        <button class="location-tab ${activeLocation === 'mitte'  ? 'active' : ''}" data-loc="mitte">Studio Mitte</button>
        <button class="location-tab ${activeLocation === 'kadewe' ? 'active' : ''}" data-loc="kadewe">KaDeWe</button>
      </div>

      ${buildPendingAppointmentsPanel()}

      ${buildActiveAppointmentsPanel()}

      ${buildArchivedAppointmentsPanel()}

      ${buildHoursTable()}

      <div class="card">
        <div id="team-table-area"></div>
      </div>

      ${buildListScheduleForm()}
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

    container.querySelector('#btn-new-mgr-appt')?.addEventListener('click', e => {
      openManagerAppointmentModal(e.currentTarget.dataset.emp)
    })

    // Inline manager schedule card
    let mscSelectedType = 'offline'
    const mscOfflineBtn = container.querySelector('#msc-type-offline')
    const mscOnlineBtn  = container.querySelector('#msc-type-online')
    const mscFieldLoc   = container.querySelector('#msc-field-location')
    const mscFieldMeet  = container.querySelector('#msc-field-meet')

    function setMscType(t) {
      mscSelectedType = t
      const onBtn  = t === 'offline' ? mscOfflineBtn : mscOnlineBtn
      const offBtn = t === 'offline' ? mscOnlineBtn  : mscOfflineBtn
      onBtn.style.borderColor  = 'var(--aubergine)'; onBtn.style.background = 'var(--aubergine)'; onBtn.style.color = '#fff'; onBtn.style.fontWeight = '600'
      offBtn.style.borderColor = 'var(--cream-dark)'; offBtn.style.background = 'var(--white)'; offBtn.style.color = 'var(--text-mid)'; offBtn.style.fontWeight = '400'
      if (mscFieldLoc)  mscFieldLoc.style.display  = t === 'offline' ? '' : 'none'
      if (mscFieldMeet) mscFieldMeet.style.display = t === 'online'  ? '' : 'none'
    }

    mscOfflineBtn?.addEventListener('click', () => setMscType('offline'))
    mscOnlineBtn?.addEventListener('click',  () => setMscType('online'))

    container.querySelector('#msc-submit')?.addEventListener('click', async e => {
      const empId    = e.currentTarget.dataset.emp
      const date     = container.querySelector('#msc-date').value
      const time     = container.querySelector('#msc-time').value || null
      const note     = container.querySelector('#msc-note').value.trim() || null
      const location = mscSelectedType === 'offline' ? (container.querySelector('#msc-location').value || null) : null
      const meetLink = mscSelectedType === 'online'  ? (container.querySelector('#msc-meet').value.trim() || null) : null

      if (!date) { showToast('Bitte wähle ein Datum.', 'error'); return }
      if (mscSelectedType === 'online' && !meetLink) { showToast('Bitte gib einen Google Meet Link ein.', 'error'); return }

      const btn = e.currentTarget
      btn.disabled = true; btn.textContent = 'Speichern...'

      // Build performance snapshot at time of booking
      const snapEmp   = employees.find(em => em.id === empId)
      const snapEvals = getEvals(empId).filter(ev => ev.manager_scores && Object.keys(ev.manager_scores).length > 0)
      const snapPi    = snapEvals[0] ? calculatePerformance(mapEntryToEngine(snapEvals[0], snapEmp?.level || 'junior', snapEmp)).PI_Monat : null
      const snapHours      = employeeHours
        .filter(h => h.employee_id === empId)
        .reduce((s, h) => s + Math.max(0, h.hours_worked - (h.break_minutes || 0) / 60), 0)
      const snapPunctStats  = calcPunctualityStats(empId)
      const performance_snapshot = { pi_monat: snapPi, hours_month: Math.round(snapHours * 10) / 10, punctuality_pct: snapPunctStats.pct, captured_at: new Date().toISOString() }

      const { error } = await supabase.from('manager_appointments').insert({
        employee_id:    empId,
        manager_id:     user.id,
        scheduled_date: time ? `${date}T${time}:00` : date,
        type:           mscSelectedType,
        location,
        meet_link:      meetLink,
        note:           note || null,
        status:         'confirmed',
        initiated_by:   user.id,
        performance_snapshot,
      })

      if (error) {
        showToast('Fehler: ' + error.message, 'error')
        btn.disabled = false; btn.textContent = '+ TERMIN VERBINDLICH EINTRAGEN'
        return
      }
      showToast(`Termin für ${employees.find(em => em.id === empId)?.full_name ?? '–'} verbindlich eingetragen!`)
      await loadData()
      rerender()
    })

    container.querySelectorAll('.btn-confirm-emp-req[data-id]').forEach(btn => {
      btn.addEventListener('click', () => openConfirmAppointmentModal(btn.dataset.id))
    })

    container.querySelectorAll('.btn-view-protocol[data-id]').forEach(btn => {
      btn.addEventListener('click', () => openProtocolViewModal(btn.dataset.id))
    })

    container.querySelectorAll('.btn-save-protocol[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const apptId       = btn.dataset.id
        const protocolText = container.querySelector(`.appt-protocol-ta[data-id="${apptId}"]`)?.value.trim() || null
        const transcriptText = container.querySelector(`.appt-transcript-ta[data-id="${apptId}"]`)?.value.trim() || null
        btn.disabled = true; btn.textContent = 'Speichern...'
        const { error } = await supabase.from('manager_appointments')
          .update({ protocol_text: protocolText, transcript_text: transcriptText })
          .eq('id', apptId)
        if (error) {
          showToast('Fehler: ' + error.message, 'error')
          btn.disabled = false; btn.textContent = 'Protokoll speichern'
          return
        }
        showToast('Protokoll gespeichert!')
        btn.disabled = false; btn.textContent = 'Protokoll speichern'
        await loadData(); rerender()
      })
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
      tab.addEventListener('click', () => {
        activeLocation = tab.dataset.loc
        localStorage.setItem('activeLocation', activeLocation)
        rerender()
      })
    })

    container.querySelectorAll('.new-emp-skill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const skill  = (availableSkills.length ? availableSkills : DEFAULT_SKILLS).find(s => s.id === btn.dataset.skill)
        const active = btn.dataset.active !== 'true'
        btn.dataset.active    = active
        btn.style.borderColor = active ? (skill?.color || 'var(--aubergine)') : 'var(--cream-dark)'
        btn.style.background  = active ? (skill?.color || 'var(--aubergine)') : 'var(--white)'
        btn.style.color       = active ? '#fff' : 'var(--text-mid)'
        btn.style.fontWeight  = active ? '600' : '400'
        btn.textContent       = (skill?.label ?? btn.dataset.skill) + (active ? ' ✓' : '')
      })
    })

    container.querySelector('#add-employee-form')?.addEventListener('submit', async e => {
      e.preventDefault()
      const btn     = container.querySelector('#add-submit-btn')
      const errorEl = container.querySelector('#add-error')
      btn.disabled  = true; btn.textContent = 'Anlegen…'
      errorEl.style.display = 'none'
      const selectedSkills = []
      e.target.querySelectorAll('.new-emp-skill-btn[data-active="true"]').forEach(b => selectedSkills.push(b.dataset.skill))
      try {
        const formObj = Object.fromEntries(new FormData(e.target))
        const assignedStudios = []
        if (e.target.querySelector('[name="studio_kadewe"]')?.checked)  assignedStudios.push('KaDeWe')
        if (e.target.querySelector('[name="studio_mitte"]')?.checked)   assignedStudios.push('Studio Mitte')
        formObj.assigned_studios = assignedStudios
        await addEmployee(formObj, selectedSkills)
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

    container.querySelectorAll('.btn-edit-target[data-emp]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation()   // don't open the daily hours modal
        openTargetHoursModal(btn.dataset.emp)
      })
    })

    container.querySelectorAll('.btn-edit-skills[data-emp]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation()
        openSkillEditModal(btn.dataset.emp)
      })
    })

    container.querySelectorAll('.btn-correct-hours[data-emp]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation()
        openHistoricalCorrectionModal(btn.dataset.emp)
      })
    })

    // Global pending appointment actions (list view)
    container.querySelectorAll('.btn-global-confirm-appt[data-id]').forEach(btn => {
      btn.addEventListener('click', () => openConfirmAppointmentModal(btn.dataset.id))
    })

    container.querySelectorAll('.btn-global-decline-appt[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Anfrage ablehnen?')) return
        const { error } = await supabase.from('manager_appointments')
          .update({ status: 'cancelled' }).eq('id', btn.dataset.id)
        if (error) { showToast('Fehler: ' + error.message, 'error'); return }
        showToast('Anfrage abgelehnt.')
        await loadData(); rerender()
      })
    })

    // Warning badge tooltips
    container.querySelectorAll('.mod-warn-badge').forEach(badge => {
      let tip = null
      const show = () => {
        if (tip) return
        tip = document.createElement('div')
        tip.style.cssText = 'position:fixed;z-index:9999;background:rgba(17,17,17,0.92);color:#fff;padding:9px 13px;border-radius:6px;font-size:0.78rem;line-height:1.6;max-width:280px;white-space:pre-wrap;box-shadow:0 4px 16px rgba(0,0,0,0.28);pointer-events:none'
        tip.textContent = badge.dataset.tooltip
        document.body.appendChild(tip)
        const r = badge.getBoundingClientRect()
        tip.style.top  = Math.min(r.bottom + 6, window.innerHeight - 120) + 'px'
        tip.style.left = Math.min(r.left, window.innerWidth - 300) + 'px'
      }
      const hide = () => { tip?.remove(); tip = null }
      badge.addEventListener('mouseenter', show)
      badge.addEventListener('mouseleave', hide)
      badge.addEventListener('click', e => { e.stopPropagation(); tip ? hide() : show() })
    })

    // List view: view archived protocol
    container.querySelectorAll('.btn-view-protocol[data-id]').forEach(btn => {
      btn.addEventListener('click', () => openProtocolViewModal(btn.dataset.id))
    })

    // List view: confirmed appointments protocol save
    container.querySelectorAll('.lsf-save-protocol[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const apptId       = btn.dataset.id
        const protocolText   = container.querySelector(`.lsf-protocol-ta[data-id="${apptId}"]`)?.value.trim() || null
        const transcriptText = container.querySelector(`.lsf-transcript-ta[data-id="${apptId}"]`)?.value.trim() || null
        btn.disabled = true; btn.textContent = 'Speichern...'
        const { error } = await supabase.from('manager_appointments')
          .update({ protocol_text: protocolText, transcript_text: transcriptText })
          .eq('id', apptId)
        if (error) { showToast('Fehler: ' + error.message, 'error'); btn.disabled = false; btn.textContent = 'Protokoll speichern'; return }
        showToast('Protokoll gespeichert!')
        btn.disabled = false; btn.textContent = 'Protokoll speichern'
        await loadData(); rerender()
      })
    })

    // List view: inline booking form
    let lsfSelectedType = 'offline'
    const lsfOfflineBtn = container.querySelector('#lsf-type-offline')
    const lsfOnlineBtn  = container.querySelector('#lsf-type-online')
    const lsfFieldLoc   = container.querySelector('#lsf-field-location')
    const lsfFieldMeet  = container.querySelector('#lsf-field-meet')

    function setLsfType(t) {
      lsfSelectedType = t
      const onBtn  = t === 'offline' ? lsfOfflineBtn : lsfOnlineBtn
      const offBtn = t === 'offline' ? lsfOnlineBtn  : lsfOfflineBtn
      onBtn.style.borderColor  = 'var(--aubergine)'; onBtn.style.background = 'var(--aubergine)'; onBtn.style.color = '#fff'; onBtn.style.fontWeight = '600'
      offBtn.style.borderColor = 'var(--cream-dark)'; offBtn.style.background = 'var(--white)'; offBtn.style.color = 'var(--text-mid)'; offBtn.style.fontWeight = '400'
      if (lsfFieldLoc)  lsfFieldLoc.style.display  = t === 'offline' ? '' : 'none'
      if (lsfFieldMeet) lsfFieldMeet.style.display = t === 'online'  ? '' : 'none'
    }

    lsfOfflineBtn?.addEventListener('click', () => setLsfType('offline'))
    lsfOnlineBtn?.addEventListener('click',  () => setLsfType('online'))

    container.querySelector('#lsf-submit')?.addEventListener('click', async e => {
      const empId    = container.querySelector('#lsf-employee')?.value
      const date     = container.querySelector('#lsf-date')?.value
      const time     = container.querySelector('#lsf-time')?.value || null
      const note     = container.querySelector('#lsf-note')?.value.trim() || null
      const location = lsfSelectedType === 'offline' ? (container.querySelector('#lsf-location')?.value || null) : null
      const meetLink = lsfSelectedType === 'online'  ? (container.querySelector('#lsf-meet')?.value.trim() || null) : null

      if (!empId)  { showToast('Bitte wähle einen Mitarbeiter.', 'error'); return }
      if (!date)   { showToast('Bitte wähle ein Datum.', 'error'); return }
      if (!time)   { showToast('Bitte wähle eine Uhrzeit.', 'error'); return }
      if (lsfSelectedType === 'online' && !meetLink) { showToast('Bitte gib einen Google Meet Link ein.', 'error'); return }

      const btn = e.currentTarget
      btn.disabled = true; btn.textContent = 'Speichern...'

      // Performance snapshot
      const snapEmp   = employees.find(em => em.id === empId)
      const snapEvals = getEvals(empId).filter(ev => ev.manager_scores && Object.keys(ev.manager_scores).length > 0)
      const snapPi    = snapEvals[0] ? calculatePerformance(mapEntryToEngine(snapEvals[0], snapEmp?.level || 'junior', snapEmp)).PI_Monat : null
      const snapHours       = employeeHours.filter(h => h.employee_id === empId).reduce((s, h) => s + Math.max(0, h.hours_worked - (h.break_minutes || 0) / 60), 0)
      const snapPunctStats  = calcPunctualityStats(empId)
      const performance_snapshot = { pi_monat: snapPi, hours_month: Math.round(snapHours * 10) / 10, punctuality_pct: snapPunctStats.pct, captured_at: new Date().toISOString() }

      const { error } = await supabase.from('manager_appointments').insert({
        employee_id:    empId,
        manager_id:     user.id,
        scheduled_date: `${date}T${time}:00`,
        type:           lsfSelectedType,
        location,
        meet_link:      meetLink,
        note:           note || null,
        status:         'confirmed',
        initiated_by:   user.id,
        performance_snapshot,
      })

      if (error) {
        showToast('Fehler: ' + error.message, 'error')
        btn.disabled = false; btn.textContent = '📅 + TERMIN VERBINDLICH EINTRAGEN'
        return
      }
      showToast(`Termin für ${snapEmp?.full_name ?? '–'} verbindlich eingetragen!`)
      await loadData(); rerender()
    })

    container.querySelector('#lsf-employee')?.addEventListener('change', e => {
      const empId   = e.target.value
      const preview = container.querySelector('#lsf-punctuality-preview')
      if (!preview) return
      if (!empId) { preview.innerHTML = ''; return }
      const { total, punctual, late, pct } = calcPunctualityStats(empId)
      const pctColor = pct === null ? 'var(--text-light)'
        : pct >= 80 ? '#27AE60'
        : pct >= 60 ? 'var(--gold)'
        : 'var(--terracotta)'
      preview.innerHTML = total > 0
        ? `<div style="background:rgba(61,43,53,0.06);border-radius:var(--radius-sm);padding:10px 14px">
             <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--aubergine);margin-bottom:4px">Pünktlichkeits-Statistik für diesen Monat</div>
             <div style="font-size:0.9rem;font-weight:600;color:${pctColor}">${pct}% (${punctual} Tage pünktlich / ${late} Tage verspätet)</div>
           </div>`
        : '<div style="background:rgba(61,43,53,0.06);border-radius:var(--radius-sm);padding:10px 14px;font-size:0.82rem;color:var(--text-light)">Noch keine Einträge für diesen Monat.</div>'
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
  return { mitte: 'Studio Mitte', kadewe: 'KaDeWe' }[loc] ?? loc ?? '–'
}

function buildTimeOptions(selected = '') {
  let o = `<option value="">– Uhrzeit wählen –</option>`
  for (let h = 8; h <= 21; h++) {
    const hh = String(h).padStart(2, '0')
    o += `<option value="${hh}:00" ${selected === hh + ':00' ? 'selected' : ''}>${hh}:00 Uhr</option>`
    if (h < 21) o += `<option value="${hh}:30" ${selected === hh + ':30' ? 'selected' : ''}>${hh}:30 Uhr</option>`
  }
  return o
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
