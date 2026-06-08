import { supabase } from '../lib/supabase.js'

export function StudioAdmin({ user }) {
  const role      = user?.profile?.role ?? ''
  const isAdmin   = role === 'admin'
  const isManager = user?.profile?.is_manager || role === 'manager' || isAdmin

  let locations        = []
  let treatments       = []
  let availableSkills  = []
  let staffProfiles    = []
  let activeTab        = 'treatments'
  let container        = null
  let editingTreatment = undefined
  let editingLocation  = undefined

  const _now = new Date()
  let reportYear  = _now.getFullYear()
  let reportMonth = _now.getMonth() + 1
  let reportLogs  = []
  let reportHours = []

  let activeStaffSubTab = 'users'
  let loginHistory      = []
  let punctualityMap    = {}

  // ── Guard ────────────────────────────────────────────────────────────────────
  if (!isManager) {
    return {
      render: async () => {
        const el = document.createElement('div')
        el.className = 'main-content'
        el.innerHTML = '<div class="empty-state"><p>Kein Zugang.</p></div>'
        return el
      }
    }
  }

  // ── Data ─────────────────────────────────────────────────────────────────────

  async function loadData() {
    const [locRes, treatRes, skillsRes] = await Promise.all([
      supabase.from('locations').select('*').order('name'),
      supabase.from('treatments').select('*, location:location_id(name)').order('name'),
      supabase.from('skills').select('*').order('name'),
    ])
    locations       = locRes.data    ?? []
    treatments      = (treatRes.data ?? []).filter(t => t.is_deleted !== true)
    availableSkills = skillsRes.data ?? []
  }

  async function loadStaffData() {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('full_name')
    if (error) { showToast('Fehler beim Laden: ' + error.message, 'error'); return }
    staffProfiles = data ?? []
  }

  async function loadReportData() {
    const mm       = String(reportMonth).padStart(2, '0')
    const firstDay = `${reportYear}-${mm}-01`
    const lastDate = new Date(reportYear, reportMonth, 0).getDate()
    const lastDay  = `${reportYear}-${mm}-${String(lastDate).padStart(2, '0')}`
    const [logsRes, hoursRes] = await Promise.all([
      supabase.from('daily_revenue_logs')
        .select('*, employee:employee_id(full_name), treatment:treatment_id(name, duration)')
        .gte('created_at', firstDay + 'T00:00:00')
        .lte('created_at', lastDay + 'T23:59:59')
        .order('created_at'),
      supabase.from('employee_daily_hours')
        .select('*, employee:employee_id(full_name)')
        .gte('date', firstDay)
        .lte('date', lastDay)
        .order('date'),
    ])
    reportLogs  = logsRes.data  ?? []
    reportHours = hoursRes.data ?? []
  }

  async function loadPunctualityStats() {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 30)
    const cutoffStr = cutoff.toISOString().slice(0, 10)
    const { data } = await supabase
      .from('employee_daily_hours')
      .select('employee_id, date, was_late, late_comment')
      .gte('date', cutoffStr)
    punctualityMap = {}
    for (const h of (data ?? [])) {
      if (!punctualityMap[h.employee_id]) {
        punctualityMap[h.employee_id] = { totalDays: 0, lateDays: 0, lateEntries: [] }
      }
      punctualityMap[h.employee_id].totalDays++
      if (h.was_late) {
        punctualityMap[h.employee_id].lateDays++
        if (h.late_comment) {
          punctualityMap[h.employee_id].lateEntries.push({ date: h.date, comment: h.late_comment })
        }
      }
    }
  }

  async function loadLoginHistory() {
    const { data, error } = await supabase
      .from('login_history')
      .select('*')
      .order('logged_at', { ascending: false })
      .limit(200)
    if (error) { console.error('EXAKTER SUPABASE PROTOKOLL-FEHLER:', error); showToast('Login-Protokolle konnten nicht geladen werden.', 'error'); loginHistory = []; return }
    loginHistory = data ?? []
  }

  // ── Treatment CRUD ───────────────────────────────────────────────────────────

  async function saveTreatment(data, id = null) {
    const name = (data.name ?? '').trim()
    if (!name) { showToast('Name ist erforderlich.', 'error'); return }
    const payload = {
      name,
      price:       Number(Math.max(0, parseFloat(data.price) || 0)),
      duration:    Number(Math.max(1, parseInt(data.duration, 10) || 60)),
      location_id: (data.location_id && data.location_id !== '') ? data.location_id : null,
      active:      data.active === true,
    }
    const { error } = id
      ? await supabase.from('treatments').update(payload).eq('id', id)
      : await supabase.from('treatments').insert(payload)
    if (error) { showToast('Fehler: ' + error.message, 'error'); return false }
    showToast(id ? 'Behandlung aktualisiert.' : 'Behandlung erstellt.')
    await loadData(); editingTreatment = undefined; rerender()
    return true
  }

  async function deactivateTreatment(id) {
    if (!confirm('Behandlung deaktivieren?')) return
    const { error } = await supabase.from('treatments').update({ active: false }).eq('id', id)
    if (error) { showToast('Fehler: ' + error.message, 'error'); return }
    showToast('Behandlung deaktiviert.')
    await loadData(); rerender()
  }

  async function deleteTreatment(id) {
    const t = treatments.find(x => x.id === id)
    if (!confirm(`Behandlung "${t?.name ?? ''}" archivieren?`)) return
    const { error } = await supabase.from('treatments').update({ is_deleted: true }).eq('id', id)
    if (error) { showToast('Fehler: ' + error.message, 'error'); return }
    showToast('Behandlung archiviert.')
    await loadData(); rerender()
  }

  // ── Location CRUD ─────────────────────────────────────────────────────────────

  async function saveLocation(data, id = null) {
    const name = (data.name ?? '').trim()
    if (!name) { showToast('Name ist erforderlich.', 'error'); return }
    const slug    = (data.slug?.trim() || name).toLowerCase().replace(/\s+/g, '-')
    const payload = { name, slug, daily_revenue_target: Math.max(0, parseFloat(data.daily_revenue_target) || 0) }
    const { error } = id
      ? await supabase.from('locations').update(payload).eq('id', id)
      : await supabase.from('locations').insert(payload)
    if (error) { showToast('Fehler: ' + error.message, 'error'); return }
    showToast(id ? 'Standort aktualisiert.' : 'Standort erstellt.')
    await loadData(); editingLocation = undefined; rerender()
  }

  async function deleteLocation(id) {
    const l = locations.find(x => x.id === id)
    if (!confirm(`Standort "${l?.name ?? ''}" endgültig löschen?`)) return
    const { error } = await supabase.from('locations').delete().eq('id', id)
    if (error) { showToast('Löschen nicht möglich: ' + error.message, 'error'); return }
    showToast('Standort gelöscht.')
    await loadData(); rerender()
  }

  // ── Staff management (Admin only) ─────────────────────────────────────────────

  async function updateRole(profileId, newRole) {
    const { error } = await supabase.from('profiles').update({ role: newRole }).eq('id', profileId)
    if (error) { showToast('Fehler: ' + error.message, 'error'); await loadStaffData(); rerender(); return }
    showToast('Rolle erfolgreich aktualisiert.')
    await loadStaffData(); rerender()
  }

  async function updateAssignedStudios(profileId, studios) {
    const { error } = await supabase.from('profiles').update({ assigned_studios: studios }).eq('id', profileId)
    if (error) { showToast('Fehler: ' + error.message, 'error'); return }
    showToast('Studios aktualisiert.')
    const p = staffProfiles.find(x => x.id === profileId)
    if (p) p.assigned_studios = studios
  }

  async function toggleActive(profileId, isCurrentlyActive) {
    const ownId = user?.id ?? user?.profile?.id
    if (profileId === ownId) { showToast('Du kannst deinen eigenen Status nicht ändern.', 'error'); return }
    const newValue = !isCurrentlyActive
    const { error } = await supabase.from('profiles').update({ is_active: newValue }).eq('id', profileId)
    if (error) { showToast('Fehler: ' + error.message, 'error'); return }
    const p = staffProfiles.find(x => x.id === profileId)
    if (p) p.is_active = newValue
    showToast(newValue ? 'Mitarbeiter aktiviert.' : 'Mitarbeiter deaktiviert.')
    rerender()
  }

  // ── CSV helpers ───────────────────────────────────────────────────────────────

  function triggerDownload(csvContent, filename) {
    const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = filename
    document.body.appendChild(a); a.click()
    setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 100)
  }

  function downloadRevenueCsv() {
    const mm     = String(reportMonth).padStart(2, '0')
    const header = 'Datum;Mitarbeiter;Behandlung;Preis (EUR);Upsell (EUR);Trinkgeld (EUR);Zahlungsart;Status;Zahlungsart 1;Betrag 1 (EUR);Zahlungsart 2;Betrag 2 (EUR)'
    const rows   = reportLogs.map(l => {
      const date   = new Date(l.created_at).toLocaleDateString('de-DE')
      const emp    = (l.employee?.full_name ?? '-').replace(/;/g, ',')
      const treat  = (l.treatment?.name    ?? '-').replace(/;/g, ',')
      const price  = Number(l.revenue      ?? 0).toFixed(2).replace('.', ',')
      const upsell = Number(l.upsell_amount ?? 0).toFixed(2).replace('.', ',')
      const tip    = Number(l.tip           ?? 0).toFixed(2).replace('.', ',')
      const method = l.payment_method ?? '-'
      const status = l.is_cancelled ? 'STORNIERT' : l.is_no_show ? 'NO-SHOW' : 'OK'
      const amt1   = l.payment_method_2 ? Number(l.amount_method_1 ?? 0).toFixed(2).replace('.', ',') : price
      const method2 = l.payment_method_2 ?? ''
      const amt2   = l.payment_method_2 ? Number(l.amount_method_2 ?? 0).toFixed(2).replace('.', ',') : '0,00'
      return `${date};${emp};${treat};${price};${upsell};${tip};${method};${status};${method};${amt1};${method2};${amt2}`
    })
    const active   = reportLogs.filter(l => !l.is_cancelled)
    const sumPrice = active.reduce((s, l) => s + Number(l.revenue ?? 0), 0)
    const sumTip   = active.reduce((s, l) => s + Number(l.tip    ?? 0), 0)
    triggerDownload([header, ...rows, '', `GESAMTSUMME;;;${sumPrice.toFixed(2).replace('.', ',')};;${sumTip.toFixed(2).replace('.', ',')};;;;;;`].join('\n'), `umsatz_${reportYear}_${mm}.csv`)
  }

  function downloadHoursCsv() {
    const mm     = String(reportMonth).padStart(2, '0')
    const header = 'Datum;Mitarbeiter;Arbeitsstunden;Pause (Min);Netto-Stunden'
    const rows   = reportHours.map(h => {
      const date   = new Date(h.date + 'T12:00:00').toLocaleDateString('de-DE')
      const emp    = (h.employee?.full_name ?? '-').replace(/;/g, ',')
      const worked = Number(h.hours_worked  ?? 0).toFixed(2).replace('.', ',')
      const pause  = Number(h.break_minutes ?? 0)
      const net    = Math.max(0, Number(h.hours_worked ?? 0) - Number(h.break_minutes ?? 0) / 60).toFixed(2).replace('.', ',')
      return `${date};${emp};${worked};${pause};${net}`
    })
    const sumBrutto = reportHours.reduce((s, h) => s + Number(h.hours_worked  ?? 0), 0)
    const sumPause  = reportHours.reduce((s, h) => s + Number(h.break_minutes ?? 0), 0)
    const sumNetto  = reportHours.reduce((s, h) => s + Math.max(0, Number(h.hours_worked ?? 0) - Number(h.break_minutes ?? 0) / 60), 0)
    triggerDownload([header, ...rows, '', `GESAMTSUMME;;${sumBrutto.toFixed(2).replace('.', ',')} Std;${sumPause} Min;${sumNetto.toFixed(2).replace('.', ',')} Std`].join('\n'), `stunden_${reportYear}_${mm}.csv`)
  }

  async function togglePunctual(hourId, currentValue) {
    const newValue = !currentValue
    const entry    = reportHours.find(h => h.id === hourId)
    if (entry) entry.is_punctual = newValue
    rerender()
    const { error } = await supabase.from('employee_daily_hours')
      .update({ is_punctual: newValue }).eq('id', hourId)
    if (error) {
      showToast('Fehler: ' + error.message, 'error')
      if (entry) entry.is_punctual = currentValue
      rerender()
    }
  }

  // ── Treatment edit modal ──────────────────────────────────────────────────────

  function openEditTreatmentModal(treatmentId) {
    const t = treatments.find(x => x.id === treatmentId)
    if (!t) return

    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100dvh;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:16px;box-sizing:border-box'

    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:460px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="padding:18px 20px 0">
          <h3 style="margin:0;font-size:1.05rem;color:var(--aubergine)">Behandlung bearbeiten</h3>
          <div style="font-size:0.78rem;color:var(--text-light);margin-top:2px">${(t.name ?? '').replace(/</g, '&lt;')}</div>
        </div>
        <div style="padding:16px 20px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label style="grid-column:1/-1;display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Name *
            <input id="et-name" type="text" value="${(t.name ?? '').replace(/"/g, '&quot;')}" placeholder="z.B. Shellac" style="${inputStyle}">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Preis (EUR) *
            <input id="et-price" type="number" min="0" step="0.01" value="${t.price ?? 0}" style="${inputStyle}">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Dauer (Min.)
            <input id="et-duration" type="number" min="1" value="${t.duration ?? 60}" style="${inputStyle}">
          </label>
          <label style="grid-column:1/-1;display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Standort
            <select id="et-location" style="${inputStyle}">
              <option value="">Alle Standorte</option>
              ${locations.map(l => `<option value="${l.id}" ${t.location_id === l.id ? 'selected' : ''}>${l.name}</option>`).join('')}
            </select>
          </label>
          <label style="grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:0.85rem;cursor:pointer">
            <input id="et-active" type="checkbox" ${t.active !== false ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--aubergine)">
            Aktiv
          </label>
          <div id="et-msg" style="display:none;grid-column:1/-1;font-size:0.875rem;padding:10px 14px;border-radius:var(--radius-sm)"></div>
        </div>
        <div style="padding:0 20px 20px;display:flex;gap:8px;flex-wrap:wrap">
          <button id="et-save" class="btn btn-accent">[ Änderungen speichern ]</button>
          <button id="et-cancel" class="btn btn-ghost">[ Abbrechen ]</button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    const msgEl   = overlay.querySelector('#et-msg')
    const saveBtn = overlay.querySelector('#et-save')

    function showMsg(text) {
      msgEl.textContent      = text
      msgEl.style.display    = 'block'
      msgEl.style.background = '#fdecea'
      msgEl.style.color      = '#8b2e1a'
      msgEl.style.border     = '1px solid var(--terracotta)'
    }

    overlay.querySelector('#et-cancel').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

    saveBtn.addEventListener('click', async () => {
      const name       = overlay.querySelector('#et-name').value.trim()
      const price      = overlay.querySelector('#et-price').value
      const duration   = overlay.querySelector('#et-duration').value
      const locationId = overlay.querySelector('#et-location').value
      const active     = overlay.querySelector('#et-active').checked

      msgEl.style.display = 'none'
      if (!name) { showMsg('Name ist erforderlich.'); return }

      saveBtn.disabled    = true
      saveBtn.textContent = '[ Wird gespeichert... ]'

      const ok = await saveTreatment({ name, price, duration, location_id: locationId, active }, treatmentId)
      if (ok) {
        overlay.remove()
      } else {
        saveBtn.disabled    = false
        saveBtn.textContent = '[ Änderungen speichern ]'
      }
    })
  }

  // ── HTML builders ─────────────────────────────────────────────────────────────

  function buildTreatmentForm(t = null) {
    return `
      <div class="card" style="margin-bottom:20px;border:2px solid var(--aubergine)">
        <div class="card-header">
          <h4>${!t ? 'Neue Behandlung' : 'Behandlung bearbeiten'}</h4>
          <button id="cancel-treatment-form" class="btn btn-ghost btn-sm">Abbrechen</button>
        </div>
        <div style="padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label style="grid-column:1/-1;display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Name *
            <input id="treat-name" type="text" value="${t?.name ?? ''}" placeholder="z.B. Shellac" style="${inputStyle}">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Preis (EUR) *
            <input id="treat-price" type="number" min="0" step="0.01" value="${t?.price ?? ''}" placeholder="0.00" style="${inputStyle}">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Dauer (Min.)
            <input id="treat-duration" type="number" min="1" value="${t?.duration ?? 60}" style="${inputStyle}">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Standort (optional)
            <select id="treat-location" style="${inputStyle}">
              <option value="">Alle Standorte</option>
              ${locations.map(l => `<option value="${l.id}" ${t?.location_id === l.id ? 'selected' : ''}>${l.name}</option>`).join('')}
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:0.85rem;cursor:pointer">
            <input id="treat-active" type="checkbox" ${t?.active !== false ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--aubergine)">
            Aktiv
          </label>
        </div>
        <div style="padding:0 16px 16px">
          <button id="save-treatment-form" class="btn btn-accent">Speichern</button>
        </div>
      </div>
    `
  }

  function buildLocationForm(l = null) {
    return `
      <div class="card" style="margin-bottom:20px;border:2px solid var(--aubergine)">
        <div class="card-header">
          <h4>${!l ? 'Neuer Standort' : 'Standort bearbeiten'}</h4>
          <button id="cancel-location-form" class="btn btn-ghost btn-sm">Abbrechen</button>
        </div>
        <div style="padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Name *
            <input id="loc-name" type="text" value="${l?.name ?? ''}" placeholder="z.B. Mitte" style="${inputStyle}">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Slug *
            <input id="loc-slug" type="text" value="${l?.slug ?? ''}" placeholder="mitte" style="${inputStyle}">
          </label>
          <label style="grid-column:1/-1;display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Tages-Umsatzziel (EUR)
            <input id="loc-target" type="number" min="0" step="10" value="${l?.daily_revenue_target ?? 0}" style="${inputStyle}">
          </label>
        </div>
        <div style="padding:0 16px 16px">
          <button id="save-location-form" class="btn btn-accent">Speichern</button>
        </div>
      </div>
    `
  }

  function buildSkillsPanel() {
    return `
      <div class="card" style="margin-bottom:20px">
        <div class="card-header"><h4>Neuen Skill erstellen</h4></div>
        <div style="padding:14px 16px;display:flex;gap:10px">
          <input id="skill-new-name" type="text" placeholder="Skill-Name" style="${inputStyle};flex:1">
          <button id="skill-create-btn" class="btn btn-accent btn-sm" style="white-space:nowrap">Erstellen</button>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h4>Alle Skills (${availableSkills.length})</h4></div>
        ${availableSkills.length ? `
          <div style="padding:8px 16px 16px;display:flex;flex-direction:column;gap:6px">
            ${availableSkills.map(s => `
              <div class="skill-item" data-id="${s.id}" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--cream-dark);border-radius:var(--radius-sm)">
                <span class="skill-item-label" style="font-size:0.9rem;color:var(--aubergine);font-weight:500">${s.name ?? s.id}</span>
                <div style="display:flex;gap:6px">
                  <button class="btn btn-ghost btn-sm btn-rename-skill" data-id="${s.id}" style="font-size:0.75rem;padding:3px 8px">Umbenennen</button>
                  <button class="btn btn-sm btn-delete-skill" data-id="${s.id}" style="background:var(--terracotta);color:#fff;font-size:0.72rem;padding:4px 8px">Löschen</button>
                </div>
              </div>
            `).join('')}
          </div>
        ` : `<div class="empty-state" style="padding:32px 20px"><p>Noch keine Skills angelegt.</p></div>`}
      </div>
    `
  }

  function buildStaffPanel() {
    const roleOptions = [
      { value: 'admin',    label: 'Admin'    },
      { value: 'manager',  label: 'Manager'  },
      { value: 'employee', label: 'Employee' },
    ]
    const STUDIOS = ['KaDeWe', 'Studio Mitte']

    if (!staffProfiles.length) {
      return `<div class="empty-state" style="padding:48px 20px"><p>Noch keine Mitarbeiterprofile vorhanden.</p></div>`
    }

    return `
      <div class="card">
        <div class="card-header"><h4>Alle Mitarbeiter (${staffProfiles.length})</h4></div>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>E-Mail</th>
                <th>Aktuelle Rolle</th>
                <th>Studios</th>
                <th>Pünktlichkeit (30 Tage)</th>
                <th style="text-align:center">Status / Aktionen</th>
              </tr>
            </thead>
            <tbody>
              ${staffProfiles.map(p => {
                const ps = punctualityMap[p.id]
                const punctCell = !ps
                  ? `<span style="font-size:0.78rem;color:var(--text-light)">Keine Daten</span>`
                  : `<div style="font-size:0.82rem;color:var(--text-mid);line-height:1.6">
                       Pünktlichkeit (Eigenauskunft): <strong style="color:${ps.lateDays > 0 ? 'var(--terracotta)' : '#27AE60'}">${ps.lateDays} mal zu spät</strong> von ${ps.totalDays} Arbeitstagen
                       ${ps.lateEntries.length > 0
                         ? `<br><button class="btn-show-late-reasons" data-empid="${p.id}" style="background:none;border:none;font-size:0.78rem;color:var(--aubergine);text-decoration:underline;cursor:pointer;padding:2px 0">[ Gründe einsehen ]</button>`
                         : ''}
                     </div>`
                return `
                <tr>
                  <td style="font-weight:600;color:var(--aubergine)">${p.full_name ?? '–'}</td>
                  <td style="color:var(--text-mid);font-size:0.84rem">${p.email ?? '–'}</td>
                  <td>
                    <select class="staff-role-select" data-id="${p.id}" style="${selectStyle}">
                      ${roleOptions.map(r => `<option value="${r.value}" ${(p.role ?? 'employee') === r.value ? 'selected' : ''}>${r.label}</option>`).join('')}
                    </select>
                  </td>
                  <td>
                    <div style="display:flex;gap:12px;flex-wrap:wrap">
                      ${STUDIOS.map(studio => `
                        <label style="display:flex;align-items:center;gap:5px;font-size:0.83rem;cursor:pointer;white-space:nowrap;user-select:none">
                          <input type="checkbox" class="studio-check" data-profile="${p.id}" data-studio="${studio}"
                            ${(p.assigned_studios ?? []).some(s => s.toLowerCase() === studio.toLowerCase()) ? 'checked' : ''}
                            style="width:14px;height:14px;accent-color:var(--aubergine)">
                          ${studio}
                        </label>
                      `).join('')}
                    </div>
                  </td>
                  <td>${punctCell}</td>
                  <td style="text-align:center">
                    <div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap">
                      <button
                        class="staff-toggle-btn btn btn-sm"
                        data-id="${p.id}"
                        data-active="${p.is_active !== false}"
                        style="font-size:0.78rem;padding:5px 12px;border-radius:var(--radius-sm);cursor:pointer;background:none;${p.is_active !== false ? 'border:1px solid #6B8F71;color:#3a6b3f' : 'border:1px solid var(--terracotta);color:var(--terracotta)'}"
                      >${p.is_active !== false ? '[ Aktiv ]' : '[ Inaktiv ]'}</button>
                      <button
                        class="staff-edit-btn btn btn-ghost btn-sm"
                        data-id="${p.id}"
                        style="font-size:0.78rem;padding:5px 12px"
                      >[ Bearbeiten ]</button>
                      <button
                        class="staff-delete-btn btn btn-sm"
                        data-id="${p.id}"
                        data-name="${(p.full_name ?? '').replace(/"/g, '&quot;')}"
                        style="font-size:0.78rem;padding:5px 12px;background:none;border:1px solid var(--cream-dark);color:var(--text-mid);border-radius:var(--radius-sm);cursor:pointer;transition:color 0.15s,border-color 0.15s"
                      >[ loeschen ]</button>
                    </div>
                  </td>
                </tr>`
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `
  }

  function openEditProfileModal(profileId) {
    const p = staffProfiles.find(x => x.id === profileId)
    if (!p) return

    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100dvh;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:16px;box-sizing:border-box'

    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="padding:18px 20px 0">
          <h3 style="margin:0;font-size:1.05rem;color:var(--aubergine)">Profil bearbeiten</h3>
          <div style="font-size:0.78rem;color:var(--text-light);margin-top:2px">${p.full_name ?? p.email ?? '–'}</div>
        </div>
        <div style="padding:16px 20px;display:flex;flex-direction:column;gap:12px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Vollständiger Name
            <input id="ep-name" type="text" value="${(p.full_name ?? '').replace(/"/g, '&quot;')}" style="${inputStyle}">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            E-Mail
            <input id="ep-email" type="email" value="${(p.email ?? '').replace(/"/g, '&quot;')}" style="${inputStyle}">
          </label>
          <div id="ep-msg" style="display:none;font-size:0.875rem;padding:10px 14px;border-radius:var(--radius-sm)"></div>
        </div>
        <div style="padding:0 20px 20px;display:flex;gap:8px">
          <button id="ep-save" class="btn btn-primary">[ Änderungen speichern ]</button>
          <button id="ep-cancel" class="btn btn-ghost">[ Abbrechen ]</button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    const msgEl   = overlay.querySelector('#ep-msg')
    const saveBtn = overlay.querySelector('#ep-save')

    function showMsg(text, isError) {
      msgEl.textContent      = text
      msgEl.style.display    = 'block'
      msgEl.style.background = isError ? '#fdecea' : '#e8f2e9'
      msgEl.style.color      = isError ? '#8b2e1a' : '#3a6b3f'
      msgEl.style.border     = `1px solid ${isError ? 'var(--terracotta)' : '#6B8F71'}`
    }

    overlay.querySelector('#ep-cancel').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

    saveBtn.addEventListener('click', async () => {
      const name  = overlay.querySelector('#ep-name').value.trim()
      const email = overlay.querySelector('#ep-email').value.trim()
      msgEl.style.display = 'none'

      if (!name)  { showMsg('Name darf nicht leer sein.', true);   return }
      if (!email) { showMsg('E-Mail darf nicht leer sein.', true); return }

      saveBtn.disabled    = true
      saveBtn.textContent = '[ Speichern... ]'

      const { error } = await supabase.from('profiles').update({ full_name: name, email }).eq('id', profileId)

      saveBtn.disabled    = false
      saveBtn.textContent = '[ Änderungen speichern ]'

      if (error) { showMsg('Fehler: ' + error.message, true); return }

      const idx = staffProfiles.findIndex(x => x.id === profileId)
      if (idx >= 0) { staffProfiles[idx].full_name = name; staffProfiles[idx].email = email }
      showToast('Profil aktualisiert.')
      overlay.remove()
      rerender()
    })
  }

  function buildStaffSection() {
    const subTabs = [
      { id: 'users',      label: '[ Mitarbeiter-Verwaltung ]' },
      { id: 'login-logs', label: '[ Login-Protokolle ]'       },
      { id: 'profile',    label: '[ Mein Profil ]'            },
    ]
    return `
      <div class="location-tabs" style="margin-bottom:20px">
        ${subTabs.map(t => `
          <button class="location-tab staff-sub-tab ${activeStaffSubTab === t.id ? 'active' : ''}" data-subtab="${t.id}">
            ${t.label}
          </button>
        `).join('')}
      </div>
      ${activeStaffSubTab === 'users'
        ? buildStaffPanel()
        : activeStaffSubTab === 'login-logs'
          ? buildLoginHistoryPanel()
          : buildAdminProfilePanel()}
    `
  }

  function buildLoginHistoryPanel() {
    if (!loginHistory.length) {
      return `<div class="empty-state" style="padding:48px 20px"><p>Noch keine Login-Protokolle vorhanden.</p></div>`
    }
    return `
      <div class="card">
        <div class="card-header">
          <h4>Login-Protokolle</h4>
          <span style="font-size:0.78rem;color:var(--text-light)">${loginHistory.length} Einträge</span>
        </div>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Datum / Uhrzeit</th>
                <th>Mitarbeiter</th>
                <th>E-Mail</th>
                <th>Gerät / Browser</th>
              </tr>
            </thead>
            <tbody>
              ${loginHistory.map(entry => `
                <tr>
                  <td style="white-space:nowrap;color:var(--text-mid);font-size:0.82rem">
                    ${new Date(entry.logged_at).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })}
                  </td>
                  <td style="font-weight:500;color:var(--aubergine)">
                    ${staffProfiles.find(p => p.id === entry.user_id)?.full_name ?? '–'}
                  </td>
                  <td style="color:var(--text-mid);font-size:0.84rem">${entry.email ?? '–'}</td>
                  <td style="color:var(--text-mid);font-size:0.84rem">${entry.device_info ?? '–'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `
  }

  function buildAdminProfilePanel() {
    return `
      <div class="card" style="max-width:440px">
        <h4 style="margin-bottom:20px;color:var(--aubergine)">Passwort ändern</h4>
        <div class="form-group">
          <label class="form-label" for="admin-new-pw">Neues Passwort</label>
          <input id="admin-new-pw" type="password" class="form-input" placeholder="Mindestens 6 Zeichen" autocomplete="new-password" />
        </div>
        <div class="form-group">
          <label class="form-label" for="admin-confirm-pw">Passwort bestätigen</label>
          <input id="admin-confirm-pw" type="password" class="form-input" placeholder="Passwort wiederholen" autocomplete="new-password" />
        </div>
        <div id="admin-pw-msg" style="display:none;margin-bottom:16px;font-size:0.875rem;padding:10px 14px;border-radius:var(--radius-sm)"></div>
        <button id="admin-pw-btn" class="btn btn-primary" style="width:100%">[ Passwort aktualisieren ]</button>
      </div>
    `
  }

  function buildHTML() {
    return `
      <div class="page-header">
        <h2>Studio-Admin</h2>
        <p style="color:var(--text-light);font-size:0.875rem">Behandlungen, Standorte, Skills und Monatsberichte</p>
      </div>

      <div class="location-tabs" style="margin-bottom:24px">
        <button class="location-tab ${activeTab === 'treatments' ? 'active' : ''}" data-tab="treatments">Behandlungen</button>
        <button class="location-tab ${activeTab === 'locations'  ? 'active' : ''}" data-tab="locations">Standorte</button>
        <button class="location-tab ${activeTab === 'skills'     ? 'active' : ''}" data-tab="skills">Skills</button>
        <button class="location-tab ${activeTab === 'reports'    ? 'active' : ''}" data-tab="reports">Monatsberichte</button>
        ${isAdmin ? `<button class="location-tab ${activeTab === 'staff' ? 'active' : ''}" data-tab="staff">Mitarbeiter-Verwaltung</button>` : ''}
      </div>

      ${activeTab === 'treatments' ? buildTreatmentsPanel()
      : activeTab === 'locations'  ? buildLocationsPanel()
      : activeTab === 'skills'     ? buildSkillsPanel()
      : activeTab === 'staff'      ? buildStaffSection()
      : buildReportsPanel()}
    `
  }

  function buildTreatmentsPanel() {
    return `
      ${editingTreatment !== undefined ? buildTreatmentForm(editingTreatment) : ''}
      ${editingTreatment === undefined ? `<div style="margin-bottom:16px"><button id="new-treatment-btn" class="btn btn-accent btn-sm">Behandlung anlegen</button></div>` : ''}
      <div class="card">
        <div class="card-header"><h4>Alle Behandlungen (${treatments.length})</h4></div>
        ${treatments.length ? `
          <div class="table-wrapper">
            <table>
              <thead><tr><th>Name</th><th>Preis</th><th>Dauer</th><th>Standort</th><th>Status</th><th></th></tr></thead>
              <tbody>
                ${treatments.map(t => `
                  <tr style="${!t.active ? 'opacity:0.45' : ''}">
                    <td style="font-weight:600;color:var(--aubergine)">${t.name}</td>
                    <td>${fmt(t.price)}</td>
                    <td style="color:var(--text-mid)">${t.duration} Min.</td>
                    <td style="font-size:0.82rem;color:var(--text-mid)">${t.location?.name ?? 'Alle'}</td>
                    <td>
                      <span style="font-size:0.75rem;padding:2px 8px;border-radius:20px;background:${t.active ? 'var(--success)' : 'var(--cream-dark)'};color:${t.active ? '#fff' : 'var(--text-mid)'}">
                        ${t.active ? 'Aktiv' : 'Inaktiv'}
                      </span>
                    </td>
                    <td style="white-space:nowrap">
                      <div style="display:flex;gap:4px;align-items:center">
                        <button class="btn btn-ghost btn-sm btn-edit-treat" data-id="${t.id}">Bearbeiten</button>
                        ${t.active ? `<button class="btn btn-sm btn-deactivate-treat" data-id="${t.id}" style="background:var(--gold);color:#fff;font-size:0.72rem;padding:4px 8px">Deaktivieren</button>` : ''}
                        <button class="btn btn-sm btn-delete-treat" data-id="${t.id}" style="background:var(--terracotta);color:#fff;font-size:0.72rem;padding:4px 8px">Löschen</button>
                      </div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="empty-state" style="padding:40px 20px">
            <p style="margin-bottom:16px">Noch keine Behandlungen angelegt.</p>
            <button id="new-treatment-cta" class="btn btn-accent">Erste Behandlung anlegen</button>
          </div>
        `}
      </div>
    `
  }

  function buildLocationsPanel() {
    return `
      ${editingLocation !== undefined ? buildLocationForm(editingLocation) : ''}
      ${editingLocation === undefined ? `<div style="margin-bottom:16px"><button id="new-location-btn" class="btn btn-accent btn-sm">Standort anlegen</button></div>` : ''}
      <div class="card">
        <div class="card-header"><h4>Standorte (${locations.length})</h4></div>
        ${locations.length ? `
          <div class="table-wrapper">
            <table>
              <thead><tr><th>Name</th><th>Slug</th><th>Tagesziel</th><th></th></tr></thead>
              <tbody>
                ${locations.map(l => `
                  <tr>
                    <td style="font-weight:600;color:var(--aubergine)">${l.name}</td>
                    <td style="color:var(--text-mid);font-size:0.82rem">${l.slug}</td>
                    <td style="font-weight:600">${fmt(l.daily_revenue_target)}</td>
                    <td>
                      <div style="display:flex;gap:4px;align-items:center">
                        <button class="btn btn-ghost btn-sm btn-edit-loc" data-id="${l.id}">Bearbeiten</button>
                        <button class="btn btn-sm btn-delete-loc" data-id="${l.id}" style="background:var(--terracotta);color:#fff;font-size:0.72rem;padding:4px 8px">Löschen</button>
                      </div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="empty-state" style="padding:40px 20px">
            <p style="margin-bottom:16px">Noch keine Standorte angelegt.</p>
            <button id="new-location-cta" class="btn btn-accent">Ersten Standort anlegen</button>
          </div>
        `}
      </div>
    `
  }

  function buildReportsPanel() {
    const MONTHS = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember']
    const curYear = new Date().getFullYear()
    const years   = [curYear, curYear - 1, curYear - 2]
    const activeLogs = reportLogs.filter(l => !l.is_cancelled)
    const realLogs   = activeLogs.filter(l => !l.is_no_show)
    const noShowLogs = activeLogs.filter(l =>  l.is_no_show)
    const methods      = ['bar', 'ec', 'paypal', 'online']
    const methodLabels = { bar: 'Bar', ec: 'EC-Karte', paypal: 'PayPal', online: 'Online' }
    const revenueByMethod = {}
    methods.forEach(m => {
      revenueByMethod[m] = realLogs.filter(l => (l.payment_method ?? 'bar') === m)
        .reduce((s, l) => s + Number(l.revenue ?? 0) + Number(l.upsell_amount ?? 0), 0)
    })
    const totalRevenue = methods.reduce((s, m) => s + revenueByMethod[m], 0)
    const totalTips    = realLogs.reduce((s, l) => s + Number(l.tip ?? 0), 0)
    const noShowLoss   = noShowLogs.reduce((s, l) => s + Number(l.revenue ?? 0), 0)
    const netWorkMins  = reportHours.reduce((s, h) => s + Math.max(0, Number(h.hours_worked ?? 0) * 60 - Number(h.break_minutes ?? 0)), 0)
    const netWorkHours = (netWorkMins / 60).toFixed(1)
    const treatMins    = realLogs.reduce((s, l) => s + Number(l.treatment?.duration ?? 60), 0)
    const avgUtil      = netWorkMins > 0 ? Math.round((treatMins / netWorkMins) * 100) : 0
    const utilColor    = avgUtil >= 80 ? '#27AE60' : avgUtil >= 50 ? 'var(--gold)' : 'var(--terracotta)'
    const hasData = reportLogs.length > 0 || reportHours.length > 0

    return `
      <div class="card" style="margin-bottom:20px">
        <div style="padding:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <select id="report-month" style="${inputStyle};width:auto;min-width:120px">
            ${MONTHS.map((m, i) => `<option value="${i+1}" ${reportMonth === i+1 ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
          <select id="report-year" style="${inputStyle};width:auto">
            ${years.map(y => `<option value="${y}" ${reportYear === y ? 'selected' : ''}>${y}</option>`).join('')}
          </select>
          <button id="load-report-btn" class="btn btn-accent btn-sm">Laden</button>
          ${hasData ? `
            <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
              <button id="export-revenue-btn" class="btn btn-ghost btn-sm">Umsatz-Export (.CSV)</button>
              <button id="export-hours-btn"   class="btn btn-ghost btn-sm">Stundenkonto-Export (.CSV)</button>
            </div>
          ` : ''}
        </div>
      </div>

      ${!hasData ? `
        <div class="empty-state" style="padding:40px 20px">
          <p>Keine Daten für ${MONTHS[reportMonth - 1]} ${reportYear}.</p>
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px">
          ${[
            { label: 'Gesamtumsatz',    value: fmt(totalRevenue),      color: 'var(--aubergine)' },
            { label: 'Trinkgeld',       value: fmt(totalTips),         color: '#27AE60'          },
            { label: 'No-Show-Verlust', value: fmt(noShowLoss),        color: 'var(--terracotta)'},
            { label: 'Netto-Stunden',   value: netWorkHours + ' Std.', color: 'var(--aubergine)' },
            { label: 'Auslastung',      value: avgUtil + '%',          color: utilColor          },
          ].map(k => `
            <div class="card" style="text-align:center;padding:16px">
              <div style="font-size:0.7rem;color:var(--text-mid);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">${k.label}</div>
              <div style="font-size:1.35rem;font-weight:700;color:${k.color}">${k.value}</div>
            </div>
          `).join('')}
        </div>
        <div class="card" style="margin-bottom:20px">
          <div class="card-header"><h4>Umsatz nach Zahlungsart</h4></div>
          <div style="padding:12px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px">
            ${methods.map(m => `
              <div style="text-align:center;padding:12px 8px;background:var(--cream-dark);border-radius:var(--radius-sm)">
                <div style="font-size:0.75rem;color:var(--text-mid);margin-bottom:4px">${methodLabels[m]}</div>
                <div style="font-weight:700;color:var(--aubergine)">${fmt(revenueByMethod[m])}</div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h4>Übersicht ${MONTHS[reportMonth - 1]} ${reportYear}</h4></div>
          <div style="padding:12px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px">
            ${[
              { label: 'Buchungen (aktiv)', value: realLogs.length },
              { label: 'No-Shows',          value: noShowLogs.length },
              { label: 'Stornierungen',     value: reportLogs.filter(l => l.is_cancelled).length },
              { label: 'Zeiteinträge Team', value: reportHours.length },
            ].map(r => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--cream-dark);border-radius:var(--radius-sm)">
                <span style="font-size:0.82rem;color:var(--text-mid)">${r.label}</span>
                <strong style="color:var(--aubergine)">${r.value}</strong>
              </div>
            `).join('')}
          </div>
        </div>
        ${reportHours.length > 0 ? `
          <div class="card" style="margin-top:20px">
            <div class="card-header">
              <h4>Tägliche Arbeitszeiten</h4>
              <span style="font-size:0.78rem;color:var(--text-light)">${reportHours.length} Einträge</span>
            </div>
            <div class="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Datum</th>
                    <th>Mitarbeiter</th>
                    <th>Stunden</th>
                    <th>Pünktlich</th>
                  </tr>
                </thead>
                <tbody>
                  ${[...reportHours].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0).map(h => {
                    const date    = new Date(h.date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' })
                    const empName = h.employee?.full_name ?? '–'
                    const hw      = Number(h.hours_worked ?? 0)
                    const hh      = Math.floor(hw)
                    const mm      = Math.round((hw - hh) * 60)
                    const hStr    = mm > 0 ? `${hh} Std. ${mm} Min.` : `${hh} Std.`
                    const isPunct = h.is_punctual === true
                    return `
                      <tr>
                        <td style="white-space:nowrap;color:var(--text-mid);font-size:0.82rem">${date}</td>
                        <td style="font-weight:500;color:var(--aubergine)">${empName}</td>
                        <td style="font-size:0.88rem">${hStr}</td>
                        <td>
                          <button class="btn-toggle-punctual" data-id="${h.id}" data-current="${isPunct}"
                            style="border:none;background:none;cursor:pointer;font-size:0.88rem;font-weight:700;padding:3px 0;color:${isPunct ? '#27AE60' : 'var(--terracotta)'}">
                            ${isPunct ? '[ Ja ]' : '[ Nein ]'}
                          </button>
                        </td>
                      </tr>
                    `
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>
        ` : ''}
      `}
    `
  }

  // ── Verspätungsgründe-Popup ───────────────────────────────────────────────────

  function showLateCommentsPopup(entries, anchorEl) {
    document.querySelector('.late-comments-popup')?.remove()

    const popup = document.createElement('div')
    popup.className = 'late-comments-popup'
    popup.style.cssText = 'position:fixed;z-index:9999;background:var(--white);border:1px solid var(--cream-dark);border-radius:var(--radius-md);padding:14px 16px;box-shadow:0 4px 20px rgba(0,0,0,0.18);max-width:320px;max-height:300px;overflow-y:auto'

    popup.innerHTML = `
      <div style="font-size:0.72rem;font-weight:700;color:var(--text-light);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">
        Hinterlegte Verspätungsgründe (letzte 30 Tage)
      </div>
      ${entries.map(e => `
        <div style="padding:6px 0;border-bottom:1px solid var(--cream-dark);font-size:0.83rem;color:var(--text-mid)">
          <strong style="color:var(--aubergine)">${new Date(e.date + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}</strong>
          &nbsp;&ndash;&nbsp;${(e.comment ?? '').replace(/</g, '&lt;')}
        </div>
      `).join('')}
      <button id="late-popup-close" style="margin-top:10px;background:none;border:none;font-size:0.8rem;color:var(--text-light);cursor:pointer;padding:2px 0">
        [ Schliessen ]
      </button>
    `

    document.body.appendChild(popup)

    const rect    = anchorEl.getBoundingClientRect()
    const popupW  = 320
    let   left    = Math.round(rect.left)
    if (left + popupW > window.innerWidth - 16) left = window.innerWidth - popupW - 16
    popup.style.top  = (rect.bottom + 6 + window.scrollY) + 'px'
    popup.style.left = Math.max(16, left) + 'px'

    popup.querySelector('#late-popup-close').addEventListener('click', () => popup.remove())

    function outsideClick(e) {
      if (!popup.contains(e.target) && e.target !== anchorEl) {
        popup.remove()
        document.removeEventListener('click', outsideClick)
      }
    }
    setTimeout(() => document.addEventListener('click', outsideClick), 0)
  }

  // ── Events ────────────────────────────────────────────────────────────────────

  function attachEvents() {
    container.querySelectorAll('.location-tab[data-tab]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tab = btn.dataset.tab
        if (tab === 'staff' && !isAdmin) return
        activeTab = tab; editingTreatment = undefined; editingLocation = undefined
        if (tab === 'reports') { container.innerHTML = buildHTML(); await loadReportData() }
        else if (tab === 'staff') { activeStaffSubTab = 'users'; await Promise.all([loadStaffData(), loadPunctualityStats()]) }
        rerender()
      })
    })

    // Treatment CRUD
    container.querySelector('#new-treatment-btn')?.addEventListener('click', () => { editingTreatment = null; rerender() })
    container.querySelector('#new-treatment-cta')?.addEventListener('click', () => { editingTreatment = null; rerender() })
    container.querySelector('#cancel-treatment-form')?.addEventListener('click', () => { editingTreatment = undefined; rerender() })
    container.querySelectorAll('.btn-edit-treat[data-id]').forEach(btn => {
      btn.addEventListener('click', () => openEditTreatmentModal(btn.dataset.id))
    })
    container.querySelectorAll('.btn-deactivate-treat[data-id]').forEach(btn => {
      btn.addEventListener('click', () => deactivateTreatment(btn.dataset.id))
    })
    container.querySelectorAll('.btn-delete-treat[data-id]').forEach(btn => {
      btn.addEventListener('click', () => deleteTreatment(btn.dataset.id))
    })
    container.querySelector('#save-treatment-form')?.addEventListener('click', () => {
      saveTreatment({
        name:        container.querySelector('#treat-name').value,
        price:       container.querySelector('#treat-price').value,
        duration:    container.querySelector('#treat-duration').value,
        location_id: container.querySelector('#treat-location').value,
        active:      container.querySelector('#treat-active').checked,
      }, editingTreatment?.id)
    })

    // Location CRUD
    container.querySelector('#new-location-btn')?.addEventListener('click', () => { editingLocation = null; rerender() })
    container.querySelector('#new-location-cta')?.addEventListener('click', () => { editingLocation = null; rerender() })
    container.querySelector('#cancel-location-form')?.addEventListener('click', () => { editingLocation = undefined; rerender() })
    container.querySelectorAll('.btn-edit-loc[data-id]').forEach(btn => {
      btn.addEventListener('click', () => { editingLocation = locations.find(l => l.id === btn.dataset.id); rerender() })
    })
    container.querySelectorAll('.btn-delete-loc[data-id]').forEach(btn => {
      btn.addEventListener('click', () => deleteLocation(btn.dataset.id))
    })
    container.querySelector('#save-location-form')?.addEventListener('click', () => {
      saveLocation({
        name:                 container.querySelector('#loc-name').value,
        slug:                 container.querySelector('#loc-slug').value,
        daily_revenue_target: container.querySelector('#loc-target').value,
      }, editingLocation?.id)
    })

    // Skills CRUD
    container.querySelector('#skill-create-btn')?.addEventListener('click', async () => {
      const input = container.querySelector('#skill-new-name')
      const name  = input?.value?.trim()
      if (!name) { showToast('Bitte einen Namen eingeben.', 'error'); return }
      const btn   = container.querySelector('#skill-create-btn')
      btn.disabled = true; btn.textContent = '...'
      const { error } = await supabase.from('skills').insert({ name })
      if (error) { showToast('Fehler: ' + error.message, 'error') }
      else        { showToast(`Skill "${name}" erstellt!`) }
      btn.disabled = false; btn.textContent = 'Erstellen'
      await loadData(); rerender()
    })
    container.querySelectorAll('.btn-rename-skill[data-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id    = btn.dataset.id
        const item  = container.querySelector(`.skill-item[data-id="${id}"]`)
        if (!item) return
        const label = item.querySelector('.skill-item-label')
        const orig  = label.textContent
        const inp   = document.createElement('input')
        inp.type = 'text'; inp.value = orig
        inp.style.cssText = 'padding:4px 10px;border:2px solid var(--aubergine);border-radius:var(--radius-sm);font-size:0.88rem;background:var(--white);color:var(--aubergine);outline:none;min-width:120px'
        item.replaceChild(inp, label)
        btn.style.visibility = 'hidden'
        inp.focus(); inp.select()
        let committed = false
        async function commitRename() {
          if (committed) return; committed = true
          const newName = inp.value.trim()
          if (!newName || newName === orig) { item.replaceChild(label, inp); btn.style.visibility = ''; return }
          const { error } = await supabase.from('skills').update({ name: newName }).eq('id', id)
          if (error) { showToast('Fehler: ' + error.message, 'error') }
          else        { showToast(`Skill umbenannt: "${newName}"`) }
          await loadData(); rerender()
        }
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter')  { e.preventDefault(); commitRename() }
          if (e.key === 'Escape') { committed = true; item.replaceChild(label, inp); btn.style.visibility = '' }
        })
        inp.addEventListener('blur', commitRename)
      })
    })
    container.querySelectorAll('.btn-delete-skill[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const skill = availableSkills.find(s => s.id === btn.dataset.id)
        if (!confirm(`Skill "${skill?.name ?? ''}" dauerhaft löschen?`)) return
        const { error } = await supabase.from('skills').delete().eq('id', btn.dataset.id)
        if (error) { showToast('Fehler: ' + error.message, 'error'); return }
        showToast(`Skill "${skill?.name ?? ''}" gelöscht.`)
        await loadData(); rerender()
      })
    })

    // Reports
    container.querySelector('#load-report-btn')?.addEventListener('click', async () => {
      const mEl = container.querySelector('#report-month')
      const yEl = container.querySelector('#report-year')
      if (mEl) reportMonth = parseInt(mEl.value, 10)
      if (yEl) reportYear  = parseInt(yEl.value, 10)
      const btn = container.querySelector('#load-report-btn')
      if (btn) { btn.disabled = true; btn.textContent = 'Lädt...' }
      await loadReportData(); rerender()
    })
    container.querySelector('#export-revenue-btn')?.addEventListener('click', downloadRevenueCsv)
    container.querySelector('#export-hours-btn')?.addEventListener('click',   downloadHoursCsv)
    container.querySelectorAll('.btn-toggle-punctual[data-id]').forEach(btn => {
      btn.addEventListener('click', () => togglePunctual(btn.dataset.id, btn.dataset.current === 'true'))
    })

    // Staff: role change
    container.querySelectorAll('.staff-role-select[data-id]').forEach(sel => {
      sel.addEventListener('change', () => updateRole(sel.dataset.id, sel.value))
    })

    // Staff: assigned_studios checkboxes
    container.querySelectorAll('.studio-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const profileId = cb.dataset.profile
        const profile   = staffProfiles.find(p => p.id === profileId)
        if (!profile) return
        const studio  = cb.dataset.studio
        const current = profile.assigned_studios ?? []
        const updated = cb.checked
          ? [...current.filter(s => s.toLowerCase() !== studio.toLowerCase()), studio]
          : current.filter(s => s.toLowerCase() !== studio.toLowerCase())
        updateAssignedStudios(profileId, updated)
      })
    })

    // Staff: toggle active/inactive
    container.querySelectorAll('.staff-toggle-btn[data-id]').forEach(btn => {
      btn.addEventListener('click', () => toggleActive(btn.dataset.id, btn.dataset.active === 'true'))
    })

    // Staff: edit profile (name + email)
    container.querySelectorAll('.staff-edit-btn[data-id]').forEach(btn => {
      btn.addEventListener('click', () => openEditProfileModal(btn.dataset.id))
    })

    // Staff: delete user completely
    container.querySelectorAll('.staff-delete-btn[data-id]').forEach(btn => {
      btn.addEventListener('mouseenter', () => { btn.style.color = 'var(--terracotta)'; btn.style.borderColor = 'var(--terracotta)' })
      btn.addEventListener('mouseleave', () => { btn.style.color = 'var(--text-mid)';   btn.style.borderColor = 'var(--cream-dark)' })
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name || 'diesen Mitarbeiter'
        if (!confirm(`Mitarbeiter "${name}" wirklich komplett loeschen?\n\nDieser Vorgang entfernt den Account dauerhaft und kann nicht rueckgaengig gemacht werden.`)) return
        btn.disabled    = true
        btn.textContent = '[ wird geloescht... ]'
        const { error } = await supabase.rpc('delete_user_completely', { target_user_id: btn.dataset.id })
        if (error) {
          showToast('Fehler beim Loeschen: ' + error.message, 'error')
          btn.disabled    = false
          btn.textContent = '[ loeschen ]'
          return
        }
        staffProfiles = staffProfiles.filter(p => p.id !== btn.dataset.id)
        showToast('Mitarbeiter wurde geloescht.', 'success')
        rerender()
      })
    })

    // Staff: Verspätungsgründe-Popup
    container.querySelectorAll('.btn-show-late-reasons[data-empid]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation()
        const entries = punctualityMap[btn.dataset.empid]?.lateEntries ?? []
        showLateCommentsPopup(entries, btn)
      })
    })

    // Staff: sub-tab navigation
    container.querySelectorAll('.staff-sub-tab[data-subtab]').forEach(btn => {
      btn.addEventListener('click', async () => {
        activeStaffSubTab = btn.dataset.subtab
        if (activeStaffSubTab === 'login-logs') {
          if (!staffProfiles.length) await loadStaffData()
          await loadLoginHistory()
        }
        rerender()
      })
    })

    // Staff: admin password change
    const adminPwBtn = container.querySelector('#admin-pw-btn')
    if (adminPwBtn) {
      adminPwBtn.addEventListener('click', async () => {
        const pwEl  = container.querySelector('#admin-new-pw')
        const cfEl  = container.querySelector('#admin-confirm-pw')
        const msgEl = container.querySelector('#admin-pw-msg')

        const pw = pwEl.value
        const cf = cfEl.value
        msgEl.style.display = 'none'

        function showMsg(text, isError) {
          msgEl.textContent      = text
          msgEl.style.display    = 'block'
          msgEl.style.background = isError ? '#fdecea' : '#e8f2e9'
          msgEl.style.color      = isError ? '#8b2e1a' : '#3a6b3f'
          msgEl.style.border     = `1px solid ${isError ? 'var(--terracotta)' : '#6B8F71'}`
        }

        if (!pw || !cf)    { showMsg('Bitte alle Felder ausfüllen.', true); return }
        if (pw !== cf)     { showMsg('Die Passwörter stimmen nicht überein.', true); return }
        if (pw.length < 6) { showMsg('Das Passwort muss mindestens 6 Zeichen lang sein.', true); return }

        adminPwBtn.disabled    = true
        adminPwBtn.textContent = '[ Wird gespeichert... ]'
        const { error } = await supabase.auth.updateUser({ password: pw })
        adminPwBtn.disabled    = false
        adminPwBtn.textContent = '[ Passwort aktualisieren ]'

        if (error) { showMsg(error.message, true) }
        else {
          showMsg('Passwort erfolgreich aktualisiert.', false)
          pwEl.value = ''
          cfEl.value = ''
        }
      })
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

const inputStyle  = 'padding:8px 10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;width:100%'
const selectStyle = 'padding:6px 10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.85rem;background:#fff;color:var(--aubergine);cursor:pointer;min-width:110px'

function fmt(n) {
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
