import { supabase } from '../lib/supabase.js'

export function DailyCheckout({ user, onNavigate }) {
  const isManager = user?.profile?.is_manager || user?.profile?.role === 'manager'

  let locations          = []
  let treatments         = []
  let employees          = []
  let todayLogs          = []
  let selectedLocationId = user?.profile?.location_id ?? null
  let container          = null

  // ── Data loading ──────────────────────────────────────────────────────────────

  async function loadData() {
    const baseQueries = [
      supabase.from('locations').select('*').order('name'),
      supabase.from('treatments').select('*').eq('active', true).order('name'),
      fetchTodayLogs(),
    ]

    const [locRes, treatRes, logRes, empRes] = await Promise.all(
      isManager
        ? [...baseQueries, supabase.from('profiles').select('id,full_name').eq('role', 'employee').order('full_name')]
        : baseQueries
    )
    locations  = locRes.data   ?? []
    treatments = (treatRes.data ?? []).filter(t => t.is_deleted !== true)
    todayLogs  = logRes
    if (isManager) employees = empRes?.data ?? []

    if (!selectedLocationId) {
      if (isManager) {
        selectedLocationId = locations[0]?.id ?? null
      } else {
        const slug = user?.profile?.location
        selectedLocationId = locations.find(l => l.slug === slug)?.id ?? locations[0]?.id ?? null
      }
    }
  }

  async function fetchTodayLogs() {
    const today = new Date().toISOString().slice(0, 10)
    let query = supabase
      .from('daily_revenue_logs')
      .select('*, treatment:treatment_id(name, price, duration), employee:employee_id(full_name)')
      .gte('created_at', today + 'T00:00:00')
      .lte('created_at', today + 'T23:59:59')
      .order('created_at', { ascending: false })

    if (!isManager) {
      query = query.eq('employee_id', user.id)
    } else if (selectedLocationId) {
      query = query.eq('location_id', selectedLocationId)
    }

    const { data } = await query
    return data ?? []
  }

  // ── Computed helpers ──────────────────────────────────────────────────────────

  function locationTreatments() {
    let result = selectedLocationId
      ? treatments.filter(t => !t.location_id || t.location_id === selectedLocationId)
      : treatments
    // deduplicate by id — prevents duplicate DB rows from rendering multiple times
    const seen = new Set()
    return result.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true })
  }

  function todaySummary() {
    const real    = todayLogs.filter(l => !l.is_no_show)
    const noShows = todayLogs.filter(l => l.is_no_show)
    const revenue = real.reduce((s, l) => s + Number(l.revenue), 0)
    const tips    = todayLogs.reduce((s, l) => s + Number(l.tip), 0)
    return { total: todayLogs.length, noShows: noShows.length, revenue, tips }
  }

  function canEdit(log) {
    const logDate = new Date(log.created_at).toISOString().slice(0, 10)
    const today   = new Date().toISOString().slice(0, 10)
    if (logDate !== today) return false
    if (isManager) return true
    return log.employee_id === user.id
  }

  // ── Save / delete ─────────────────────────────────────────────────────────────

  async function saveLog(data, logId = null) {
    const treatment  = treatments.find(t => t.id === data.treatment_id)
    const isNoShow   = !!data.is_no_show
    const upsell     = isNoShow ? 0 : Math.max(0, Number(data.upsell_amount) || 0)
    const tip        = isNoShow ? 0 : Math.max(0, Number(data.tip) || 0)
    const revenue    = isNoShow ? 0 : (Number(treatment?.price ?? 0) + upsell)
    const employeeId = data.employee_id ?? user.id

    const payload = {
      employee_id:    employeeId,
      location_id:    selectedLocationId,
      treatment_id:   data.treatment_id,
      revenue,
      upsell_amount:  upsell,
      tip,
      is_no_show:     isNoShow,
      payment_method: data.payment_method ?? 'bar',
      created_by:     user.id,
    }

    let error
    if (logId) {
      const existing = todayLogs.find(l => l.id === logId)
      if (existing && !canEdit(existing)) {
        showToast('Nur am selben Tag editierbar.', 'error')
        return false
      }
      const res = await supabase.from('daily_revenue_logs').update(payload).eq('id', logId)
      error = res.error
    } else {
      const res = await supabase.from('daily_revenue_logs').insert(payload).select().single()
      if (!res.error) {
        const emp = employees.find(e => e.id === employeeId) ?? { full_name: user.profile?.full_name }
        const enriched = {
          ...res.data,
          treatment: { name: treatment?.name, price: treatment?.price },
          employee:  { full_name: emp.full_name },
        }
        todayLogs = [enriched, ...todayLogs]
        rerender()
      }
      error = res.error
    }

    if (error) {
      showToast('Fehler: ' + (error.message || 'Unbekannter Fehler'), 'error')
      await refreshLogs()
      return false
    }

    showToast(logId ? 'Eintrag aktualisiert.' : 'Eintrag gespeichert.')
    await refreshLogs()
    return true
  }

  async function deleteLog(logId) {
    const log = todayLogs.find(l => l.id === logId)
    if (!log || !canEdit(log)) {
      showToast('Nur am selben Tag löschbar.', 'error')
      return
    }
    if (!confirm('Eintrag wirklich löschen?')) return

    const { error } = await supabase.from('daily_revenue_logs').delete().eq('id', logId)
    if (error) { showToast('Fehler: ' + error.message, 'error'); return }
    showToast('Eintrag gelöscht.')
    todayLogs = todayLogs.filter(l => l.id !== logId)
    rerender()
    await refreshLogs()
  }

  async function refreshLogs() {
    todayLogs = await fetchTodayLogs()
    rerender()
  }

  // ── Modal ─────────────────────────────────────────────────────────────────────

  const PAYMENT_METHODS = [
    { value: 'bar',    label: 'Bar'          },
    { value: 'ec',     label: 'EC-Karte'     },
    { value: 'paypal', label: 'PayPal'        },
    { value: 'online', label: 'Online vorab' },
  ]

  function openModal(treatment, existingLog = null) {
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

    const isEdit   = !!existingLog
    const isNS     = existingLog?.is_no_show ?? false
    const upsell   = existingLog?.upsell_amount ?? 0
    const tip      = existingLog?.tip ?? 0
    const curPay   = existingLog?.payment_method ?? 'bar'
    const curEmpId = existingLog?.employee_id ?? user.id

    // Mutable active treatment — changes when manager picks different one in edit mode
    let activeTreatment = treatment ?? {}
    const availableTreats = locationTreatments()

    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:420px;width:100%;max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3)">

        <!-- Header: always static title -->
        <div style="display:flex;justify-content:space-between;align-items:center;padding:18px 20px 0">
          <h3 style="margin:0;font-size:1.05rem;color:var(--aubergine)">${isEdit ? 'Eintrag bearbeiten' : (activeTreatment.name ?? 'Behandlung')}</h3>
          <button id="modal-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-light);line-height:1;padding:4px">✕</button>
        </div>

        <!-- Treatment switcher (edit + manager): same width/style as price badge -->
        ${isEdit && isManager ? `
        <div style="margin:12px 20px 0;background:var(--cream-dark);border-radius:var(--radius-sm)">
          <select id="modal-treatment"
            style="width:100%;padding:10px 14px;background:transparent;border:none;outline:none;font-size:0.92rem;color:var(--aubergine);font-weight:600;cursor:pointer;border-radius:var(--radius-sm)">
            ${availableTreats.map(t => `<option value="${t.id}" ${t.id === activeTreatment.id ? 'selected' : ''}>${t.name}</option>`).join('')}
          </select>
        </div>
        ` : ''}

        <!-- Price badge — id for live update -->
        <div style="margin:8px 20px 0;display:flex;justify-content:space-between;align-items:center;background:var(--cream-dark);border-radius:var(--radius-sm);padding:10px 14px">
          <span style="font-size:0.85rem;color:var(--text-mid)">Behandlungspreis</span>
          <strong id="modal-price-val" style="color:var(--aubergine);font-size:1.05rem">${fmt(activeTreatment.price ?? 0)}</strong>
        </div>

        <div style="padding:14px 20px;display:flex;flex-direction:column;gap:12px">

          ${isManager && employees.length ? `
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Mitarbeiter zuordnen
            <select id="modal-employee" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;background:var(--white)">
              ${employees.map(e => `<option value="${e.id}" ${e.id === curEmpId ? 'selected' : ''}>${e.full_name}</option>`).join('')}
            </select>
          </label>
          ` : ''}

          <!-- Payment method -->
          <div>
            <div style="font-size:0.85rem;color:var(--text-mid);margin-bottom:6px">Zahlungsart</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${PAYMENT_METHODS.map(({ value, label }) => {
                const active = curPay === value
                return `<button type="button" class="pay-btn" data-pay="${value}"
                  style="padding:7px 12px;border:2px solid ${active ? 'var(--aubergine)' : 'var(--cream-dark)'};border-radius:var(--radius-sm);background:${active ? 'var(--cream)' : 'var(--white)'};font-size:0.82rem;cursor:pointer;font-weight:${active ? '600' : '400'};color:${active ? 'var(--aubergine)' : 'var(--text-mid)'};transition:all 0.15s">
                  ${label}
                </button>`
              }).join('')}
            </div>
          </div>

          <!-- Upsell -->
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Zusatzverkauf (€)
            <input id="modal-upsell" type="number" min="0" step="0.01" value="${upsell}"
              style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:1rem;${isNS ? 'opacity:0.4;pointer-events:none' : ''}">
          </label>

          <!-- Tip -->
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Trinkgeld (€)
            <input id="modal-tip" type="number" min="0" step="0.01" value="${tip}"
              style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:1rem;${isNS ? 'opacity:0.4;pointer-events:none' : ''}">
          </label>

          <!-- No-show -->
          <label id="noshow-label" style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:0.9rem;padding:10px;background:${isNS ? 'rgba(181,87,58,0.08)' : 'transparent'};border-radius:var(--radius-sm);transition:background 0.15s">
            <input id="modal-noshow" type="checkbox" ${isNS ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--terracotta)">
            No-Show
          </label>

          <!-- Revenue preview -->
          <div style="font-size:0.8rem;color:var(--text-light);text-align:right">
            Umsatz: <strong id="modal-rev-val">${fmt(isEdit ? existingLog.revenue : (activeTreatment.price ?? 0))}</strong>
          </div>
        </div>

        <!-- Footer -->
        <div style="padding:0 20px 20px;display:flex;gap:8px">
          ${isEdit ? `<button id="modal-delete" class="btn" style="background:var(--terracotta);color:#fff;flex:0 0 auto">Löschen</button>` : ''}
          <button id="modal-save" class="btn btn-accent" style="flex:1">Speichern</button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    const upsellInput  = overlay.querySelector('#modal-upsell')
    const tipInput     = overlay.querySelector('#modal-tip')
    const nsCheckbox   = overlay.querySelector('#modal-noshow')
    const noshowLabel  = overlay.querySelector('#noshow-label')
    const revVal       = overlay.querySelector('#modal-rev-val')
    const priceVal     = overlay.querySelector('#modal-price-val')
    const treatSelect  = overlay.querySelector('#modal-treatment')

    // Treatment switcher (edit + manager only): sync price badge + revenue preview
    treatSelect?.addEventListener('change', () => {
      activeTreatment = availableTreats.find(t => t.id === treatSelect.value) ?? activeTreatment
      priceVal.textContent = fmt(activeTreatment.price ?? 0)
      updatePreview()
    })

    // Payment button toggle
    let selectedPayment = curPay
    overlay.querySelectorAll('.pay-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedPayment = btn.dataset.pay
        overlay.querySelectorAll('.pay-btn').forEach(b => {
          const on = b.dataset.pay === selectedPayment
          b.style.borderColor = on ? 'var(--aubergine)' : 'var(--cream-dark)'
          b.style.background  = on ? 'var(--cream)'     : 'var(--white)'
          b.style.fontWeight  = on ? '600'              : '400'
          b.style.color       = on ? 'var(--aubergine)' : 'var(--text-mid)'
        })
      })
    })

    function updatePreview() {
      const ns    = nsCheckbox.checked
      const u     = ns ? 0 : Math.max(0, parseFloat(upsellInput.value) || 0)
      const price = activeTreatment.price ?? 0
      revVal.textContent = fmt(ns ? 0 : (price + u))
      upsellInput.style.opacity       = ns ? '0.4' : '1'
      upsellInput.style.pointerEvents = ns ? 'none' : ''
      tipInput.style.opacity          = ns ? '0.4' : '1'
      tipInput.style.pointerEvents    = ns ? 'none' : ''
      noshowLabel.style.background    = ns ? 'rgba(181,87,58,0.08)' : 'transparent'
      if (ns) { upsellInput.value = '0'; tipInput.value = '0' }
    }

    nsCheckbox.addEventListener('change', updatePreview)
    upsellInput.addEventListener('input', updatePreview)

    overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

    overlay.querySelector('#modal-save').addEventListener('click', async () => {
      const ns    = nsCheckbox.checked
      const u     = ns ? 0 : Math.max(0, parseFloat(upsellInput.value) || 0)
      const t     = ns ? 0 : Math.max(0, parseFloat(tipInput.value) || 0)
      const empId = overlay.querySelector('#modal-employee')?.value ?? user.id

      if (u < 0 || t < 0) { showToast('Keine negativen Beträge.', 'error'); return }

      const saveBtn = overlay.querySelector('#modal-save')
      saveBtn.disabled = true
      saveBtn.textContent = 'Speichern...'

      const ok = await saveLog({
        treatment_id:   activeTreatment.id,
        upsell_amount:  u,
        tip:            t,
        is_no_show:     ns,
        payment_method: selectedPayment,
        employee_id:    empId,
      }, existingLog?.id)

      if (ok) overlay.remove()
      else { saveBtn.disabled = false; saveBtn.textContent = 'Speichern' }
    })

    overlay.querySelector('#modal-delete')?.addEventListener('click', () => {
      overlay.remove()
      deleteLog(existingLog.id)
    })
  }

  // ── Cockpit helpers ───────────────────────────────────────────────────────────

  function buildKassensturz() {
    if (!isManager) return ''
    const METHODS = [
      { key: 'bar',    label: 'Bar'          },
      { key: 'ec',     label: 'EC-Karte'     },
      { key: 'paypal', label: 'PayPal'        },
      { key: 'online', label: 'Online vorab' },
    ]
    const byPayment = {}
    for (const log of todayLogs.filter(l => !l.is_no_show)) {
      const pm = log.payment_method ?? 'bar'
      byPayment[pm] = (byPayment[pm] ?? 0) + Number(log.revenue)
    }
    const noShowLoss = todayLogs
      .filter(l => l.is_no_show)
      .reduce((s, l) => s + Number(l.treatment?.price ?? 0), 0)

    return `
      <div class="card" style="margin-bottom:16px;background:var(--aubergine);border:none">
        <div style="padding:14px 18px 8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
          <span style="font-size:0.75rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:rgba(245,237,228,0.55)">Kassensturz (Heute)</span>
          ${noShowLoss > 0
            ? `<span style="font-size:0.78rem;color:rgba(245,237,228,0.7);background:rgba(0,0,0,0.25);padding:3px 10px;border-radius:20px">No-Show Verlust: ${fmt(noShowLoss)}</span>`
            : `<span style="font-size:0.75rem;color:rgba(245,237,228,0.35)">Keine No-Shows</span>`}
        </div>
        <div style="padding:0 18px 14px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
          ${METHODS.map(({ key, label }) => {
            const total = byPayment[key] ?? 0
            return `
              <div style="background:rgba(245,237,228,0.09);border-radius:var(--radius-sm);padding:10px 6px;text-align:center">
                <div style="font-size:0.65rem;color:rgba(245,237,228,0.5);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">${label}</div>
                <div style="font-weight:700;font-size:0.98rem;color:${total > 0 ? 'var(--cream)' : 'rgba(245,237,228,0.25)'}">${fmt(total)}</div>
              </div>`
          }).join('')}
        </div>
      </div>`
  }

  function buildTeamStatus() {
    if (!isManager) return ''
    const byEmp = {}
    for (const log of todayLogs) {
      if (!log.employee_id) continue
      if (!byEmp[log.employee_id]) {
        byEmp[log.employee_id] = { name: log.employee?.full_name ?? '–', revenue: 0, tips: 0, minutes: 0, counts: {} }
      }
      const e = byEmp[log.employee_id]
      e.tips += Number(log.tip)
      if (!log.is_no_show) {
        e.revenue += Number(log.revenue)
        e.minutes += Number(log.treatment?.duration ?? treatments.find(t => t.id === log.treatment_id)?.duration ?? 60)
        const n = log.treatment?.name ?? '?'
        e.counts[n] = (e.counts[n] ?? 0) + 1
      }
    }
    if (!Object.keys(byEmp).length) return ''

    const cards = Object.entries(byEmp).map(([empId, d]) => {
      const split = Object.entries(d.counts).map(([n, c]) => `${c}× ${n}`).join(' · ') || '–'
      const util  = d.minutes > 0 ? Math.round((d.minutes / (8 * 60)) * 100) : 0
      const uCol  = util >= 80 ? '#27AE60' : util >= 50 ? 'var(--gold)' : 'var(--terracotta)'
      return `
        <div style="background:var(--cream);border-radius:var(--radius-md);padding:12px 14px;display:flex;flex-direction:column;gap:5px">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px">
            <span style="font-weight:600;color:var(--aubergine);font-size:0.9rem">${d.name}</span>
            <div style="font-size:0.82rem;display:flex;gap:10px">
              <span style="font-weight:600;color:var(--aubergine)">${fmt(d.revenue)}</span>
              <span style="color:var(--gold)">TG: ${fmt(d.tips)}</span>
            </div>
          </div>
          <div style="font-size:0.75rem;color:var(--text-mid)">${split}</div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:2px">
            <span style="font-size:0.75rem;color:var(--text-mid)">Stunden:</span>
            <input type="number" min="1" max="24" step="0.5" value="8"
              class="hours-input" data-emp="${empId}" data-minutes="${d.minutes}"
              style="width:54px;padding:3px 6px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.82rem;text-align:center">
            <span class="util-display" data-emp="${empId}" style="font-size:0.82rem;font-weight:700;color:${uCol}">
              Auslastung: ${util}%
            </span>
          </div>
        </div>`
    }).join('')

    return `
      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><h4>Team-Status & Auslastung</h4></div>
        <div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px">${cards}</div>
      </div>`
  }

  // ── HTML builders ─────────────────────────────────────────────────────────────

  function buildHTML() {
    const summary    = todaySummary()
    const treatsHere = locationTreatments()

    return `
      <div class="page-header">
        <div>
          <h2>Tagesabschluss</h2>
          <p style="color:var(--text-light);font-size:0.875rem">${new Date().toLocaleDateString('de-DE', { weekday:'long', day:'numeric', month:'long' })}</p>
        </div>
      </div>

      ${isManager ? `
        <div style="margin-bottom:16px">
          <label style="font-size:0.8rem;color:var(--text-mid);display:block;margin-bottom:6px">Standort</label>
          <select id="location-select" style="padding:8px 12px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);background:var(--white);font-size:0.9rem;min-width:160px">
            ${locations.map(l => `<option value="${l.id}" ${l.id === selectedLocationId ? 'selected' : ''}>${l.name}</option>`).join('')}
          </select>
        </div>
      ` : ''}

      ${buildKassensturz()}

      <div class="stat-grid" style="margin-bottom:24px">
        <div class="stat-card">
          <div class="stat-label">Einträge heute</div>
          <div class="stat-value">${summary.total}</div>
          <div class="stat-sub">${summary.noShows} No-Show${summary.noShows !== 1 ? 's' : ''}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Umsatz heute</div>
          <div class="stat-value" style="color:var(--aubergine)">${fmt(summary.revenue)}</div>
          <div class="stat-sub">ohne No-Shows</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Trinkgeld</div>
          <div class="stat-value" style="color:var(--gold)">${fmt(summary.tips)}</div>
          <div class="stat-sub">gesamt heute</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><h4>Behandlung erfassen</h4></div>
        ${treatsHere.length ? `
          <div class="treatment-grid">
            ${treatsHere.map(t => `
              <button class="btn-treatment" data-id="${t.id}"
                style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:10px 12px;border-radius:var(--radius-md);border:2px solid var(--cream-dark);background:var(--white);cursor:pointer;width:100%;transition:all 0.15s;text-align:left">
                <span style="font-weight:600;color:var(--aubergine);font-size:0.85rem;line-height:1.3">${t.name}</span>
                <span style="font-size:0.75rem;color:var(--text-mid)">${fmt(t.price)}</span>
              </button>
            `).join('')}
          </div>
        ` : `
          <div class="empty-state" style="padding:32px 20px">
            <span class="empty-state-icon">◉</span>
            <p>Noch keine Behandlungen für diesen Standort.</p>
            ${isManager
              ? `<p style="margin-top:8px;font-size:0.82rem;color:var(--text-light)">Lege Behandlungen im <button id="goto-admin" class="btn btn-ghost btn-sm" style="display:inline;padding:2px 6px">Studio-Admin</button> an.</p>`
              : `<p style="margin-top:8px;font-size:0.82rem;color:var(--text-light)">Bitte den Manager, Behandlungen anzulegen.</p>`
            }
          </div>
        `}
      </div>

      ${buildTeamStatus()}

      <div class="card">
        <div class="card-header"><h4>Heutige Einträge</h4><span style="font-size:0.78rem;color:var(--text-light)">${todayLogs.length} Einträge</span></div>
        ${todayLogs.length ? `
          <div class="table-wrapper" style="max-height:280px;overflow-y:auto">
            <table style="font-size:0.82rem">
              <thead>
                <tr>
                  <th style="padding:6px 10px">Zeit</th>
                  ${isManager ? '<th style="padding:6px 10px">Mitarbeiter</th>' : ''}
                  <th style="padding:6px 10px">Behandlung</th>
                  <th style="padding:6px 10px">Umsatz</th>
                  <th style="padding:6px 10px">TG</th>
                  <th style="padding:6px 10px"></th>
                </tr>
              </thead>
              <tbody>
                ${todayLogs.map(log => `
                  <tr style="${log.is_no_show ? 'opacity:0.5' : ''}">
                    <td style="padding:5px 10px;color:var(--text-mid);white-space:nowrap">${new Date(log.created_at).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' })}</td>
                    ${isManager ? `<td style="padding:5px 10px;font-size:0.78rem;color:var(--text-mid)">${log.employee?.full_name ?? '–'}</td>` : ''}
                    <td style="padding:5px 10px">
                      ${log.treatment?.name ?? '–'}
                      ${log.is_no_show ? `<span style="font-size:0.65rem;background:var(--terracotta);color:#fff;border-radius:4px;padding:1px 4px;margin-left:3px">NS</span>` : ''}
                    </td>
                    <td style="padding:5px 10px;font-weight:600;color:${log.is_no_show ? 'var(--text-light)' : 'var(--aubergine)'}">${fmt(log.revenue)}</td>
                    <td style="padding:5px 10px;color:var(--gold)">${Number(log.tip) > 0 ? fmt(log.tip) : '–'}</td>
                    <td style="padding:5px 10px">
                      ${canEdit(log) ? `
                        <div style="display:flex;gap:3px">
                          <button class="btn btn-ghost btn-sm btn-edit-log" data-id="${log.id}" style="font-size:0.72rem;padding:3px 6px">✏</button>
                          <button class="btn btn-sm btn-delete-log" data-id="${log.id}" style="font-size:0.72rem;padding:3px 6px;background:var(--terracotta);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">🗑</button>
                        </div>
                      ` : ''}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `<div class="empty-state"><span class="empty-state-icon">◉</span><p>Noch keine Einträge heute.</p></div>`}
      </div>
    `
  }

  function attachEvents() {
    container.querySelector('#location-select')?.addEventListener('change', async e => {
      selectedLocationId = e.target.value
      todayLogs = await fetchTodayLogs()
      rerender()
    })

    container.querySelectorAll('.btn-treatment[data-id]').forEach(btn => {
      btn.addEventListener('pointerenter', () => { btn.style.borderColor = 'var(--aubergine)'; btn.style.background = 'var(--cream)' })
      btn.addEventListener('pointerleave', () => { btn.style.borderColor = 'var(--cream-dark)'; btn.style.background = 'var(--white)' })
      btn.addEventListener('click', () => {
        const t = treatments.find(t => t.id === btn.dataset.id)
        if (t) openModal(t)
      })
    })

    container.querySelector('#goto-admin')?.addEventListener('click', () => onNavigate?.('admin'))

    container.querySelectorAll('.btn-edit-log[data-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const log = todayLogs.find(l => l.id === btn.dataset.id)
        if (!log) return
        const treatment = treatments.find(t => t.id === log.treatment_id)
          ?? { id: log.treatment_id, name: log.treatment?.name, price: log.treatment?.price ?? 0 }
        openModal(treatment, log)
      })
    })

    container.querySelectorAll('.btn-delete-log[data-id]').forEach(btn => {
      btn.addEventListener('click', () => deleteLog(btn.dataset.id))
    })

    // Live utilization recalculation when hours input changes
    container.querySelectorAll('.hours-input[data-emp]').forEach(input => {
      input.addEventListener('input', () => {
        const minutes = Number(input.dataset.minutes)
        const hours   = Math.max(0.5, parseFloat(input.value) || 8)
        const util    = Math.round((minutes / (hours * 60)) * 100)
        const display = container.querySelector(`.util-display[data-emp="${input.dataset.emp}"]`)
        if (!display) return
        display.textContent = `Auslastung: ${util}%`
        display.style.color = util >= 80 ? '#27AE60' : util >= 50 ? 'var(--gold)' : 'var(--terracotta)'
      })
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
