import { supabase } from '../lib/supabase.js'

export function StudioAdmin({ user }) {
  const role      = user?.profile?.role ?? ''
  const isAdmin   = role === 'admin'
  const isManager = user?.profile?.is_manager || role === 'manager' || isAdmin

  let locations        = []
  let treatments       = []
  let availableSkills  = []
  let staffProfiles    = []
  let activeTab        = 'treatments'  // 'treatments' | 'locations' | 'skills' | 'reports' | 'staff'
  let container        = null
  let editingTreatment = undefined  // undefined=list view, null=new form, {obj}=edit form
  let editingLocation  = undefined

  // Reports state
  const _now = new Date()
  let reportYear  = _now.getFullYear()
  let reportMonth = _now.getMonth() + 1  // 1–12
  let reportLogs  = []
  let reportHours = []

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
    if (error) { showToast('Fehler beim Laden der Mitarbeiter: ' + error.message, 'error'); return }
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

    if (error) { showToast('Fehler: ' + error.message, 'error'); return }
    showToast(id ? 'Behandlung aktualisiert.' : 'Behandlung erstellt.')
    await loadData()
    editingTreatment = undefined
    rerender()
  }

  async function deactivateTreatment(id) {
    if (!confirm('Behandlung deaktivieren? Sie bleibt in historischen Reports sichtbar.')) return
    const { error } = await supabase.from('treatments').update({ active: false }).eq('id', id)
    if (error) { showToast('Fehler: ' + error.message, 'error'); return }
    showToast('Behandlung deaktiviert.')
    await loadData()
    rerender()
  }

  async function deleteTreatment(id) {
    const t = treatments.find(x => x.id === id)
    if (!confirm(`Behandlung "${t?.name ?? ''}" archivieren?\n\nSie verschwindet aus allen Listen. Historische Buchungen bleiben erhalten.`)) return
    const { error } = await supabase.from('treatments').update({ is_deleted: true }).eq('id', id)
    if (error) { showToast('Fehler: ' + error.message, 'error'); return }
    showToast('Behandlung archiviert.')
    await loadData()
    rerender()
  }

  // ── Location CRUD ─────────────────────────────────────────────────────────────

  async function saveLocation(data, id = null) {
    const name = (data.name ?? '').trim()
    if (!name) { showToast('Name ist erforderlich.', 'error'); return }
    const slug = (data.slug?.trim() || name).toLowerCase().replace(/\s+/g, '-')
    const payload = {
      name,
      slug,
      daily_revenue_target: Math.max(0, parseFloat(data.daily_revenue_target) || 0),
    }
    const { error } = id
      ? await supabase.from('locations').update(payload).eq('id', id)
      : await supabase.from('locations').insert(payload)

    if (error) { showToast('Fehler: ' + error.message, 'error'); return }
    showToast(id ? 'Standort aktualisiert.' : 'Standort erstellt.')
    await loadData()
    editingLocation = undefined
    rerender()
  }

  async function deleteLocation(id) {
    const l = locations.find(x => x.id === id)
    if (!confirm(`Standort "${l?.name ?? ''}" endgültig löschen?\n\nNur möglich wenn keine Umsätze oder aktiven Mitarbeiter damit verknüpft sind.`)) return
    const { error } = await supabase.from('locations').delete().eq('id', id)
    if (error) { showToast('Löschen nicht möglich: ' + error.message, 'error'); return }
    showToast('Standort gelöscht.')
    await loadData()
    rerender()
  }

  // ── Staff management (Admin only) ─────────────────────────────────────────────

  async function updateRole(profileId, newRole) {
    const { error } = await supabase
      .from('profiles')
      .update({ role: newRole })
      .eq('id', profileId)

    if (error) {
      showToast('Fehler beim Aktualisieren der Rolle: ' + error.message, 'error')
      await loadStaffData()
      rerender()
      return
    }
    showToast('Rolle erfolgreich aktualisiert.')
    await loadStaffData()
    rerender()
  }

  function confirmDeleteProfile(profileId) {
    const ownId = user?.id ?? user?.profile?.id
    if (profileId === ownId) {
      showToast('Du kannst dein eigenes Profil nicht löschen.', 'error')
      return
    }
    const profile = staffProfiles.find(p => p.id === profileId)
    showDeleteModal(profile)
  }

  function showDeleteModal(profile) {
    const existing = document.getElementById('staff-delete-modal')
    if (existing) existing.remove()

    const overlay = document.createElement('div')
    overlay.id = 'staff-delete-modal'
    overlay.style.cssText = [
      'position:fixed;inset:0;z-index:9000',
      'display:flex;align-items:center;justify-content:center',
      'background:rgba(0,0,0,0.55)',
    ].join(';')

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:28px 24px;max-width:420px;width:90%;box-shadow:0 8px 40px rgba(0,0,0,0.25)">
        <h4 style="margin:0 0 10px;color:var(--aubergine);font-size:1.05rem">Mitarbeiter löschen?</h4>
        <p style="margin:0 0 8px;color:var(--text-mid,#666);font-size:0.9rem;line-height:1.55">
          Mitarbeiter wirklich löschen? Dadurch verliert die Person jeglichen Zugriff auf die App.
        </p>
        ${profile?.full_name ? `
          <p style="margin:0 0 20px;font-size:0.9rem">
            <strong style="color:var(--aubergine)">${profile.full_name}</strong> wird dauerhaft entfernt.
          </p>
        ` : '<div style="margin-bottom:20px"></div>'}
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button id="modal-cancel-btn" class="btn btn-ghost btn-sm">Abbrechen</button>
          <button id="modal-confirm-btn" class="btn btn-sm" style="background:var(--terracotta);color:#fff">Löschen</button>
        </div>
      </div>
    `

    overlay.querySelector('#modal-cancel-btn').addEventListener('click', () => overlay.remove())
    overlay.querySelector('#modal-confirm-btn').addEventListener('click', async () => {
      overlay.remove()
      const { error } = await supabase.from('profiles').delete().eq('id', profile.id)
      if (error) { showToast('Fehler: ' + error.message, 'error'); return }
      showToast(`${profile?.full_name ?? 'Mitarbeiter'} wurde entfernt.`)
      await loadStaffData()
      rerender()
    })
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

    document.body.appendChild(overlay)
  }

  // ── CSV helpers ───────────────────────────────────────────────────────────────

  function triggerDownload(csvContent, filename) {
    const BOM  = '﻿'
    const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = filename
    document.body.appendChild(a); a.click()
    setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 100)
  }

  function downloadRevenueCsv() {
    const mm     = String(reportMonth).padStart(2, '0')
    const header = 'Datum;Mitarbeiter;Behandlung;Preis (€);Upsell (€);Trinkgeld (€);Zahlungsart;Status;Zahlungsart 1;Betrag 1 (€);Zahlungsart 2;Betrag 2 (€)'
    const rows   = reportLogs.map(l => {
      const date    = new Date(l.created_at).toLocaleDateString('de-DE')
      const emp     = (l.employee?.full_name ?? '–').replace(/;/g, ',')
      const treat   = (l.treatment?.name    ?? '–').replace(/;/g, ',')
      const price   = Number(l.revenue      ?? 0).toFixed(2).replace('.', ',')
      const upsell  = Number(l.upsell_amount ?? 0).toFixed(2).replace('.', ',')
      const tip     = Number(l.tip           ?? 0).toFixed(2).replace('.', ',')
      const method  = l.payment_method ?? '–'
      const status  = l.is_cancelled ? 'STORNIERT' : l.is_no_show ? 'NO-SHOW' : 'OK'
      const method1 = l.payment_method ?? '–'
      const amt1    = l.payment_method_2
        ? Number(l.amount_method_1 ?? 0).toFixed(2).replace('.', ',')
        : price
      const method2 = l.payment_method_2 ?? ''
      const amt2    = l.payment_method_2
        ? Number(l.amount_method_2 ?? 0).toFixed(2).replace('.', ',')
        : '0,00'
      return `${date};${emp};${treat};${price};${upsell};${tip};${method};${status};${method1};${amt1};${method2};${amt2}`
    })
    const active   = reportLogs.filter(l => !l.is_cancelled)
    const sumPrice = active.reduce((s, l) => s + Number(l.revenue ?? 0), 0)
    const sumTip   = active.reduce((s, l) => s + Number(l.tip    ?? 0), 0)
    const sumLine  = `GESAMTSUMME;;;${sumPrice.toFixed(2).replace('.', ',')} €;;${sumTip.toFixed(2).replace('.', ',')} €;;;;;;`
    triggerDownload([header, ...rows, '', sumLine].join('\n'), `umsatz_${reportYear}_${mm}.csv`)
  }

  function downloadHoursCsv() {
    const mm     = String(reportMonth).padStart(2, '0')
    const header = 'Datum;Mitarbeiter;Arbeitsstunden;Pause (Min);Netto-Stunden'
    const rows   = reportHours.map(h => {
      const date   = new Date(h.date + 'T12:00:00').toLocaleDateString('de-DE')
      const emp    = (h.employee?.full_name ?? '–').replace(/;/g, ',')
      const worked = Number(h.hours_worked  ?? 0).toFixed(2).replace('.', ',')
      const pause  = Number(h.break_minutes ?? 0)
      const net    = Math.max(0, Number(h.hours_worked ?? 0) - Number(h.break_minutes ?? 0) / 60).toFixed(2).replace('.', ',')
      return `${date};${emp};${worked};${pause};${net}`
    })
    const sumBrutto = reportHours.reduce((s, h) => s + Number(h.hours_worked  ?? 0), 0)
    const sumPause  = reportHours.reduce((s, h) => s + Number(h.break_minutes ?? 0), 0)
    const sumNetto  = reportHours.reduce((s, h) => s + Math.max(0, Number(h.hours_worked ?? 0) - Number(h.break_minutes ?? 0) / 60), 0)
    const sumLine   = `GESAMTSUMME;;${sumBrutto.toFixed(2).replace('.', ',')} Std;${sumPause} Min;${sumNetto.toFixed(2).replace('.', ',')} Std`
    triggerDownload([header, ...rows, '', sumLine].join('\n'), `stunden_${reportYear}_${mm}.csv`)
  }

  // ── HTML ──────────────────────────────────────────────────────────────────────

  function buildTreatmentForm(t = null) {
    const isNew = !t
    return `
      <div class="card" style="margin-bottom:20px;border:2px solid var(--aubergine)">
        <div class="card-header">
          <h4>${isNew ? 'Neue Behandlung' : 'Behandlung bearbeiten'}</h4>
          <button id="cancel-treatment-form" class="btn btn-ghost btn-sm">Abbrechen</button>
        </div>
        <div style="padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label style="grid-column:1/-1;display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Name *
            <input id="treat-name" type="text" value="${t?.name ?? ''}" placeholder="z. B. Shellac" style="${inputStyle}">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Preis (€) *
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
    const isNew = !l
    return `
      <div class="card" style="margin-bottom:20px;border:2px solid var(--aubergine)">
        <div class="card-header">
          <h4>${isNew ? 'Neuer Standort' : 'Standort bearbeiten'}</h4>
          <button id="cancel-location-form" class="btn btn-ghost btn-sm">Abbrechen</button>
        </div>
        <div style="padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Name *
            <input id="loc-name" type="text" value="${l?.name ?? ''}" placeholder="z. B. Mitte" style="${inputStyle}">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Slug *
            <input id="loc-slug" type="text" value="${l?.slug ?? ''}" placeholder="mitte" style="${inputStyle}">
          </label>
          <label style="grid-column:1/-1;display:flex;flex-direction:column;gap:4px;font-size:0.85rem">
            Tages-Umsatzziel (€)
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
          <input id="skill-new-name" type="text" placeholder="Skill-Name (z. B. Shellac)" style="${inputStyle};flex:1">
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
        ` : `
          <div class="empty-state" style="padding:32px 20px">
            <p>Noch keine Skills angelegt.</p>
          </div>
        `}
      </div>
    `
  }

  function buildStaffPanel() {
    if (!isAdmin) {
      return `
        <div class="card" style="padding:32px 24px;text-align:center">
          <p style="color:var(--text-mid);font-size:0.9rem">Kein Zugang. Dieser Bereich ist nur für Administratoren sichtbar.</p>
        </div>
      `
    }

    const roleOptions = [
      { value: 'admin',    label: 'Admin'    },
      { value: 'manager',  label: 'Manager'  },
      { value: 'employee', label: 'Employee' },
    ]

    if (!staffProfiles.length) {
      return `
        <div class="empty-state" style="padding:48px 20px">
          <p>Noch keine Mitarbeiterprofile vorhanden.</p>
        </div>
      `
    }

    return `
      <div class="card">
        <div class="card-header">
          <h4>Alle Mitarbeiter (${staffProfiles.length})</h4>
        </div>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>E-Mail</th>
                <th>Aktuelle Rolle</th>
                <th style="text-align:center">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              ${staffProfiles.map(p => `
                <tr>
                  <td style="font-weight:600;color:var(--aubergine)">${p.full_name ?? '–'}</td>
                  <td style="color:var(--text-mid);font-size:0.84rem">${p.email ?? '–'}</td>
                  <td>
                    <select class="staff-role-select" data-id="${p.id}" style="${selectStyle}">
                      ${roleOptions.map(r => `
                        <option value="${r.value}" ${(p.role ?? 'employee') === r.value ? 'selected' : ''}>${r.label}</option>
                      `).join('')}
                    </select>
                  </td>
                  <td style="text-align:center">
                    <button
                      class="staff-delete-btn btn btn-sm"
                      data-id="${p.id}"
                      style="background:var(--terracotta);color:#fff;font-size:0.78rem;padding:5px 12px;border:none;border-radius:var(--radius-sm,6px);cursor:pointer"
                    >Löschen</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
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
      : activeTab === 'staff'      ? buildStaffPanel()
      : buildReportsPanel()}
    `
  }

  function buildTreatmentsPanel() {
    return `
      ${editingTreatment !== undefined ? buildTreatmentForm(editingTreatment) : ''}

      ${editingTreatment === undefined ? `
        <div style="margin-bottom:16px">
          <button id="new-treatment-btn" class="btn btn-accent btn-sm">Behandlung anlegen</button>
        </div>
      ` : ''}

      <div class="card">
        <div class="card-header"><h4>Alle Behandlungen (${treatments.length})</h4></div>
        ${treatments.length ? `
          <div class="table-wrapper">
            <table>
              <thead>
                <tr><th>Name</th><th>Preis</th><th>Dauer</th><th>Standort</th><th>Status</th><th></th></tr>
              </thead>
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

      ${editingLocation === undefined ? `
        <div style="margin-bottom:16px">
          <button id="new-location-btn" class="btn btn-accent btn-sm">Standort anlegen</button>
        </div>
      ` : ''}

      <div class="card">
        <div class="card-header"><h4>Standorte (${locations.length})</h4></div>
        ${locations.length ? `
          <div class="table-wrapper">
            <table>
              <thead>
                <tr><th>Name</th><th>Slug</th><th>Tagesziel</th><th></th></tr>
              </thead>
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
    const noShowLogs = activeLogs.filter(l => l.is_no_show)

    const methods      = ['bar', 'ec', 'paypal', 'online']
    const methodLabels = { bar: 'Bar', ec: 'EC-Karte', paypal: 'PayPal', online: 'Online' }

    const revenueByMethod = {}
    methods.forEach(m => {
      revenueByMethod[m] = realLogs
        .filter(l => (l.payment_method ?? 'bar') === m)
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
          <div class="card-header"><h4>Uebersicht ${MONTHS[reportMonth - 1]} ${reportYear}</h4></div>
          <div style="padding:12px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px">
            ${[
              { label: 'Buchungen (aktiv)',  value: realLogs.length },
              { label: 'No-Shows',           value: noShowLogs.length },
              { label: 'Stornierungen',      value: reportLogs.filter(l => l.is_cancelled).length },
              { label: 'Zeiteintraege Team', value: reportHours.length },
            ].map(r => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--cream-dark);border-radius:var(--radius-sm)">
                <span style="font-size:0.82rem;color:var(--text-mid)">${r.label}</span>
                <strong style="color:var(--aubergine)">${r.value}</strong>
              </div>
            `).join('')}
          </div>
        </div>
      `}
    `
  }

  // ── Events ────────────────────────────────────────────────────────────────────

  function attachEvents() {
    // Tab switching
    container.querySelectorAll('.location-tab[data-tab]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tab = btn.dataset.tab
        if (tab === 'staff' && !isAdmin) return
        activeTab        = tab
        editingTreatment = undefined
        editingLocation  = undefined
        if (activeTab === 'reports') {
          container.innerHTML = buildHTML()
          await loadReportData()
        } else if (activeTab === 'staff') {
          await loadStaffData()
        }
        rerender()
      })
    })

    // Treatment CRUD
    container.querySelector('#new-treatment-btn')?.addEventListener('click', () => { editingTreatment = null; rerender() })
    container.querySelector('#new-treatment-cta')?.addEventListener('click', () => { editingTreatment = null; rerender() })
    container.querySelector('#cancel-treatment-form')?.addEventListener('click', () => { editingTreatment = undefined; rerender() })
    container.querySelectorAll('.btn-edit-treat[data-id]').forEach(btn => {
      btn.addEventListener('click', () => { editingTreatment = treatments.find(t => t.id === btn.dataset.id); rerender() })
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
        const id   = btn.dataset.id
        const item = container.querySelector(`.skill-item[data-id="${id}"]`)
        if (!item) return
        const label = item.querySelector('.skill-item-label')
        const orig  = label.textContent

        const inp = document.createElement('input')
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
        if (!confirm(`Skill "${skill?.name ?? ''}" dauerhaft loeschen?\n\nDie Zuweisung an alle Mitarbeiter wird ebenfalls entfernt.`)) return
        const { error } = await supabase.from('skills').delete().eq('id', btn.dataset.id)
        if (error) { showToast('Fehler: ' + error.message, 'error'); return }
        showToast(`Skill "${skill?.name ?? ''}" geloescht.`)
        await loadData(); rerender()
      })
    })

    // Reports tab
    container.querySelector('#load-report-btn')?.addEventListener('click', async () => {
      const mEl = container.querySelector('#report-month')
      const yEl = container.querySelector('#report-year')
      if (mEl) reportMonth = parseInt(mEl.value, 10)
      if (yEl) reportYear  = parseInt(yEl.value, 10)
      const btn = container.querySelector('#load-report-btn')
      if (btn) { btn.disabled = true; btn.textContent = 'Laedt...' }
      await loadReportData()
      rerender()
    })
    container.querySelector('#export-revenue-btn')?.addEventListener('click', downloadRevenueCsv)
    container.querySelector('#export-hours-btn')?.addEventListener('click',   downloadHoursCsv)

    // Staff tab: role change
    container.querySelectorAll('.staff-role-select[data-id]').forEach(sel => {
      sel.addEventListener('change', () => updateRole(sel.dataset.id, sel.value))
    })

    // Staff tab: delete profile
    container.querySelectorAll('.staff-delete-btn[data-id]').forEach(btn => {
      btn.addEventListener('click', () => confirmDeleteProfile(btn.dataset.id))
    })
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
const selectStyle = 'padding:6px 10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.85rem;background:#fff;color:var(--aubergine);cursor:pointer;min-width:120px'

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
