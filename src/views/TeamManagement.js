import { supabase } from '../lib/supabase.js'
import { ScoreModal } from '../components/ScoreModal.js'
import { TeamTable } from '../components/TeamTable.js'
import { LineChart } from '../components/LineChart.js'
import { getAllSkills, DEFAULT_SKILLS, checkPromotionEligibility } from '../lib/skills.js'
import { formatScore, getTrend, getTrendHTML, getLatestScore, calcQualityRate, calcTotalReclamations, calcWeightedScore } from '../lib/scoring.js'
import { calculatePerformance, mapEntryToEngine, calcQPI } from '../lib/scoringEngine.js'
import { buildComparisonCard } from '../lib/buildComparisonCard.js'

export function TeamManagement({ user }) {
  let employees      = []
  let evaluations    = []
  let employeeHours  = []   // employee_daily_hours rows for current month
  let monthlyTargets = []   // employee_monthly_targets for current month
  let activeLocation = localStorage.getItem('activeLocation') || 'all'
  let view           = 'list'
  let selectedEmployee = null
  let showAddForm       = false
  let container         = null
  let availableSkills   = []   // from public.skills table
  let employeeSkillsMap = {}   // employee_id → skill_id[]
  let appointmentsMap   = {}   // employee_id → manager_appointments[]

  async function loadData() {
    const now             = new Date()
    const firstOfMonth    = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const firstOfMonthStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`

    const [empRes, evalRes, logsRes, hoursRes, targetsRes, skillsRes, empSkillsRes, apptsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('role', 'employee').order('full_name'),
      supabase.from('performance_entries').select('*').order('created_at', { ascending: false }),
      supabase.from('daily_revenue_logs').select('employee_id, tip').gte('created_at', firstOfMonth),
      supabase.from('employee_daily_hours')
        .select('employee_id, date, hours_worked, break_minutes, location_id, is_modified, original_hours')
        .gte('date', firstOfMonthStr),
      supabase.from('employee_monthly_targets')
        .select('employee_id, target_hours')
        .eq('year',  now.getFullYear())
        .eq('month', now.getMonth() + 1),
      supabase.from('skills').select('*').order('name'),
      supabase.from('employee_skills').select('employee_id, skill_id'),
      supabase.from('manager_appointments').select('*').order('scheduled_date', { ascending: false }),
    ])
    employees     = empRes.data  ?? []
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

    // Build employee_id → appointments[] lookup
    appointmentsMap = {}
    for (const a of (apptsRes.data ?? [])) {
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
      skills:    selectedSkills,
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
    const confirmed  = appts.filter(a => a.status === 'confirmed')
    const isEmpty    = !empReqs.length && !mgrPending.length && !confirmed.length
    const fmtDate    = d => new Date(d + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' })

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
                  <div style="font-weight:600;font-size:0.9rem;color:var(--aubergine)">${fmtDate(a.scheduled_date)}${a.scheduled_time ? ' · ' + a.scheduled_time.slice(0,5) + ' Uhr' : ''}</div>
                  ${a.note ? `<div style="font-size:0.78rem;color:var(--text-mid)">${a.note}</div>` : ''}
                </div>
                <button class="btn-confirm-emp-req" data-id="${a.id}" style="background:#27AE60;color:#fff;border:none;border-radius:var(--radius-sm);padding:5px 12px;font-size:0.8rem;cursor:pointer;font-weight:600;flex-shrink:0">Bestätigen</button>
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
                  <div style="font-weight:600;font-size:0.85rem;color:var(--aubergine)">${fmtDate(a.scheduled_date)}${a.scheduled_time ? ' · ' + a.scheduled_time.slice(0,5) + ' Uhr' : ''}</div>
                  <div style="font-size:0.78rem;color:var(--text-mid)">${a.type === 'online' ? '🌐 Online' : '📍 ' + locationLabel(a.location)}</div>
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
              <div style="padding:8px 0;border-bottom:1px solid var(--cream);display:flex;justify-content:space-between;align-items:center;gap:10px">
                <div>
                  <div style="font-weight:600;font-size:0.9rem;color:var(--aubergine)">${fmtDate(a.scheduled_date)}${a.scheduled_time ? ' · ' + a.scheduled_time.slice(0,5) + ' Uhr' : ''}</div>
                  <div style="font-size:0.78rem;color:var(--text-mid)">${a.type === 'online' ? '🌐 Online' : '📍 ' + locationLabel(a.location)}</div>
                  ${a.note ? `<div style="font-size:0.75rem;color:var(--text-light)">${a.note}</div>` : ''}
                </div>
                ${a.type === 'online' && a.meet_link ? `
                  <a href="${a.meet_link}" target="_blank" rel="noopener" style="background:#1a73e8;color:#fff;border-radius:var(--radius-sm);padding:5px 10px;font-size:0.78rem;font-weight:600;text-decoration:none;white-space:nowrap;flex-shrink:0">📹 Meet</a>
                ` : ''}
              </div>
            `).join('')}
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
                <option value="mitte">Berlin Mitte</option>
                <option value="kadewe">KaDeWe</option>
              </select>
            </label>
          </div>
          <div id="ma-field-meet" style="display:none">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
              Google Meet Link
              <input id="ma-meet" type="url" placeholder="https://meet.google.com/..." style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.85rem;color:var(--aubergine)">
            </label>
          </div>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Datum
            <input id="ma-date" type="date" min="${today}" value="${today}" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.95rem;color:var(--aubergine)">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Uhrzeit (optional)
            <input id="ma-time" type="time" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.95rem;color:var(--aubergine)">
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
        scheduled_date: date,
        scheduled_time: time,
        type:           selectedType,
        location,
        meet_link:      meetLink,
        note,
        status:         'pending_employee',
        initiated_by:   user.id,
      })

      if (error) {
        showToast('Fehler: ' + error.message, 'error')
        btn.disabled = false; btn.textContent = 'Einladung senden'
        return
      }
      showToast('Einladung gesendet!')
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
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
        <button class="btn btn-ghost btn-sm" id="back-to-list">← Zurück</button>
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
                </tr>
              `}).join('')}
            </tbody>
          </table>
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
        <button class="location-tab ${activeLocation === 'mitte'  ? 'active' : ''}" data-loc="mitte">Mitte</button>
        <button class="location-tab ${activeLocation === 'kadewe' ? 'active' : ''}" data-loc="kadewe">KaDeWe</button>
      </div>

      ${buildHoursTable()}

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

    container.querySelector('#btn-new-mgr-appt')?.addEventListener('click', e => {
      openManagerAppointmentModal(e.currentTarget.dataset.emp)
    })

    container.querySelectorAll('.btn-confirm-emp-req[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { error } = await supabase.from('manager_appointments')
          .update({ status: 'confirmed', manager_id: user.id }).eq('id', btn.dataset.id)
        if (error) { showToast('Fehler: ' + error.message, 'error'); return }
        showToast('Termin bestätigt!')
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
        await addEmployee(Object.fromEntries(new FormData(e.target)), selectedSkills)
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
  return { mitte: 'Mitte', kadewe: 'KaDeWe' }[loc] ?? loc ?? '–'
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
