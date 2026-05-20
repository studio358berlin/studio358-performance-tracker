import { supabase } from '../lib/supabase.js'

export function StudioAdmin({ user }) {
  const isManager = user?.profile?.is_manager || user?.profile?.role === 'manager'

  let locations  = []
  let treatments = []
  let activeTab  = 'treatments'  // 'treatments' | 'locations' | 'reports'
  let container  = null
  let editingTreatment = undefined  // undefined=list view, null=new form, {obj}=edit form
  let editingLocation  = undefined

  // Reports state
  const _now = new Date()
  let reportYear  = _now.getFullYear()
  let reportMonth = _now.getMonth() + 1  // 1–12
  let reportLogs  = []   // daily_revenue_logs for selected month
  let reportHours = []   // employee_daily_hours for selected month

  // ── Guard ────────────────────────────────────────────────────────────────────
  if (!isManager) {
    return {
      render: async () => {
        const el = document.createElement('div')
        el.className = 'main-content'
        el.innerHTML = '<div class="empty-state"><span class="empty-state-icon">⊘</span><p>Kein Zugang.</p></div>'
        return el
      }
    }
  }

  // ── Data ─────────────────────────────────────────────────────────────────────

  async function loadData() {
    const [locRes, treatRes] = await Promise.all([
      supabase.from('locations').select('*').order('name'),
      supabase.from('treatments').select('*, location:location_id(name)').order('name'),
    ])
    locations  = locRes.data  ?? []
    treatments = (treatRes.data ?? []).filter(t => t.is_deleted !== true)
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

  function buildHTML() {
    return `
      <div class="page-header">
        <h2>Studio-Admin</h2>
        <p style="color:var(--text-light);font-size:0.875rem">Behandlungen, Standorte & Monatsberichte</p>
      </div>

      <div class="location-tabs" style="margin-bottom:24px">
        <button class="location-tab ${activeTab === 'treatments' ? 'active' : ''}" data-tab="treatments">Behandlungen</button>
        <button class="location-tab ${activeTab === 'locations'  ? 'active' : ''}" data-tab="locations">Standorte</button>
        <button class="location-tab ${activeTab === 'reports'    ? 'active' : ''}" data-tab="reports">Monatsberichte</button>
      </div>

      ${activeTab === 'treatments' ? buildTreatmentsPanel()
      : activeTab === 'locations'  ? buildLocationsPanel()
      : buildReportsPanel()}
    `
  }

  function buildTreatmentsPanel() {
    return `
      ${editingTreatment !== undefined ? buildTreatmentForm(editingTreatment) : ''}

      ${editingTreatment === undefined ? `
        <div style="margin-bottom:16px">
          <button id="new-treatment-btn" class="btn btn-accent btn-sm">+ Behandlung anlegen</button>
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
                        <button class="btn btn-ghost btn-sm btn-edit-treat" data-id="${t.id}">✏</button>
                        ${t.active ? `<button class="btn btn-sm btn-deactivate-treat" data-id="${t.id}" style="background:var(--gold);color:#fff;font-size:0.72rem;padding:4px 8px">Deakt.</button>` : ''}
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
            <span class="empty-state-icon">◉</span>
            <p style="margin-bottom:16px">Noch keine Behandlungen angelegt.</p>
            <button id="new-treatment-cta" class="btn btn-accent">+ Erste Behandlung anlegen</button>
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
          <button id="new-location-btn" class="btn btn-accent btn-sm">+ Standort anlegen</button>
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
                        <button class="btn btn-ghost btn-sm btn-edit-loc" data-id="${l.id}">✏ Bearbeiten</button>
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
            <span class="empty-state-icon">◉</span>
            <p style="margin-bottom:16px">Noch keine Standorte angelegt.</p>
            <button id="new-location-cta" class="btn btn-accent">+ Ersten Standort anlegen</button>
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
      <!-- Selector row -->
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
              <button id="export-revenue-btn" class="btn btn-ghost btn-sm">📥 Umsatz-Export (.CSV)</button>
              <button id="export-hours-btn"   class="btn btn-ghost btn-sm">📋 Stundenkonto-Export (.CSV)</button>
            </div>
          ` : ''}
        </div>
      </div>

      ${!hasData ? `
        <div class="empty-state" style="padding:40px 20px">
          <span class="empty-state-icon">📂</span>
          <p>Keine Daten für ${MONTHS[reportMonth - 1]} ${reportYear}.</p>
        </div>
      ` : `

        <!-- KPI row -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px">
          ${[
            { label: 'Gesamtumsatz',   value: fmt(totalRevenue),      color: 'var(--aubergine)' },
            { label: 'Trinkgeld',      value: fmt(totalTips),         color: '#27AE60'          },
            { label: 'No-Show-Verlust',value: fmt(noShowLoss),        color: 'var(--terracotta)'},
            { label: 'Netto-Stunden',  value: netWorkHours + ' Std.', color: 'var(--aubergine)' },
            { label: 'Ø Auslastung',   value: avgUtil + '%',          color: utilColor          },
          ].map(k => `
            <div class="card" style="text-align:center;padding:16px">
              <div style="font-size:0.7rem;color:var(--text-mid);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">${k.label}</div>
              <div style="font-size:1.35rem;font-weight:700;color:${k.color}">${k.value}</div>
            </div>
          `).join('')}
        </div>

        <!-- Revenue by payment method -->
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

        <!-- Summary counts -->
        <div class="card">
          <div class="card-header"><h4>Übersicht ${MONTHS[reportMonth - 1]} ${reportYear}</h4></div>
          <div style="padding:12px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px">
            ${[
              { label: 'Buchungen (aktiv)',  value: realLogs.length },
              { label: 'No-Shows',           value: noShowLogs.length },
              { label: 'Stornierungen',      value: reportLogs.filter(l => l.is_cancelled).length },
              { label: 'Zeiteinträge Team',  value: reportHours.length },
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
        activeTab        = btn.dataset.tab
        editingTreatment = undefined
        editingLocation  = undefined
        if (activeTab === 'reports') {
          container.innerHTML = buildHTML()
          await loadReportData()
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

    // Reports tab
    container.querySelector('#load-report-btn')?.addEventListener('click', async () => {
      const mEl = container.querySelector('#report-month')
      const yEl = container.querySelector('#report-year')
      if (mEl) reportMonth = parseInt(mEl.value, 10)
      if (yEl) reportYear  = parseInt(yEl.value, 10)
      const btn = container.querySelector('#load-report-btn')
      if (btn) { btn.disabled = true; btn.textContent = 'Lädt…' }
      await loadReportData()
      rerender()
    })
    container.querySelector('#export-revenue-btn')?.addEventListener('click', downloadRevenueCsv)
    container.querySelector('#export-hours-btn')?.addEventListener('click',   downloadHoursCsv)
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

const inputStyle = 'padding:8px 10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;width:100%'

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
