import { supabase } from '../lib/supabase.js'

export function StudioAdmin({ user }) {
  const isManager = user?.profile?.is_manager || user?.profile?.role === 'manager'

  let locations  = []
  let treatments = []
  let activeTab  = 'treatments'  // 'treatments' | 'locations'
  let container  = null
  let editingTreatment = undefined  // undefined=list view, null=new form, {obj}=edit form
  let editingLocation  = undefined

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
    treatments = treatRes.data ?? []
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
    if (!confirm(`Behandlung "${t?.name ?? ''}" endgültig löschen?\n\nAchtung: Nur möglich wenn keine Umsätze damit gebucht wurden.`)) return
    const { error } = await supabase.from('treatments').delete().eq('id', id)
    if (error) { showToast('Löschen nicht möglich: ' + error.message, 'error'); return }
    showToast('Behandlung gelöscht.')
    await loadData()
    rerender()
  }

  // ── Location CRUD ─────────────────────────────────────────────────────────────

  async function saveLocation(data, id = null) {
    const payload = {
      name:                 data.name.trim(),
      slug:                 data.slug.trim().toLowerCase().replace(/\s+/g, '-'),
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
        <p style="color:var(--text-light);font-size:0.875rem">Behandlungen & Standorte verwalten</p>
      </div>

      <div class="location-tabs" style="margin-bottom:24px">
        <button class="location-tab ${activeTab === 'treatments' ? 'active' : ''}" data-tab="treatments">Behandlungen</button>
        <button class="location-tab ${activeTab === 'locations'  ? 'active' : ''}" data-tab="locations">Standorte</button>
      </div>

      ${activeTab === 'treatments' ? buildTreatmentsPanel() : buildLocationsPanel()}
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

  function attachEvents() {
    // Tab switching
    container.querySelectorAll('.location-tab[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => { activeTab = btn.dataset.tab; editingTreatment = undefined; editingLocation = undefined; rerender() })
    })

    // Treatment list (header button + empty-state CTA both open the form)
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

    // Location list (header button + empty-state CTA)
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
