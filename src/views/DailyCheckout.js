import { supabase } from '../lib/supabase.js'

// Supabase-Migration (einmalig, falls noch nicht ausgeführt):
// ALTER TABLE employee_daily_hours
//   ADD COLUMN IF NOT EXISTS location TEXT,
//   ADD COLUMN IF NOT EXISTS lunch_break_minutes INTEGER DEFAULT 0;

export function DailyCheckout({ user, onNavigate }) {
  const isManager     = user?.profile?.is_manager || user?.profile?.role === 'manager'
  const STUDIO_SLUG   = { 'KaDeWe': 'kadewe', 'Studio Mitte': 'mitte' }
  const mgrStudios    = user?.profile?.role === 'manager' ? (user?.profile?.assigned_studios ?? []) : null
  const forcedLocSlug = mgrStudios?.length === 1 ? (STUDIO_SLUG[mgrStudios[0]] ?? null) : null

  function isEmpVisible(emp) {
    if (!(emp.assigned_studios ?? []).length) return false  // kein Studio = nirgendwo eingeteilt
    if (!mgrStudios)        return true
    if (!mgrStudios.length) return true
    return mgrStudios.some(s =>
      (emp.assigned_studios ?? []).some(es => es.toLowerCase() === s.toLowerCase())
    )
  }

  let locations          = []
  let treatments         = []
  let employees          = []
  let todayLogs          = []
  let selectedLocationId = localStorage.getItem('selectedLocationId') || user?.profile?.location_id || null
  let container          = null
  let hoursToday         = null
  let teamHoursMap       = {}
  let dateFrom           = localDate()
  let dateTo             = localDate()
  let period             = localStorage.getItem('checkoutPeriod') || 'today'

  // ── Date range helper ─────────────────────────────────────────────────────────

  function logDateRange() {
    return {
      from: new Date(dateFrom + 'T00:00:00').toISOString(),
      to:   new Date(dateTo   + 'T23:59:59').toISOString(),
    }
  }

  // ── Data loading ──────────────────────────────────────────────────────────────

  async function loadData() {
    const [locRes, treatRes] = await Promise.all([
      supabase.from('locations').select('*').order('name'),
      supabase.from('treatments').select('*').eq('active', true).order('name'),
    ])
    locations  = locRes.data ?? []
    treatments = (treatRes.data ?? []).filter(t => t.is_deleted !== true)

    if (forcedLocSlug) {
      selectedLocationId = locations.find(l => l.slug === forcedLocSlug)?.id ?? null
    } else if (!selectedLocationId) {
      if (isManager) {
        selectedLocationId = 'all'
      } else {
        const slug = user?.profile?.location
        selectedLocationId = locations.find(l => l.slug === slug)?.id ?? locations[0]?.id ?? null
      }
    }

    const phase2 = [fetchTodayLogs()]
    if (isManager) {
      phase2.push(
        supabase.from('profiles').select('id,full_name,assigned_studios').eq('role', 'employee').eq('is_active', true).order('full_name')
      )
    }
    const [logRes, empRes] = await Promise.all(phase2)
    todayLogs = logRes
    if (isManager) employees = (empRes?.data ?? []).filter(isEmpVisible)

    const todayDate = dateFrom
    if (isManager) {
      const { data: hData } = await supabase
        .from('employee_daily_hours').select('*').eq('date', todayDate)
      teamHoursMap = Object.fromEntries((hData ?? []).map(h => [h.employee_id, h]))
    } else {
      const { data: hData } = await supabase
        .from('employee_daily_hours').select('*')
        .eq('employee_id', user.id).eq('date', todayDate).maybeSingle()
      hoursToday = hData ?? null
    }
  }

  async function fetchTodayLogs() {
    const { from, to } = logDateRange()
    let query = supabase
      .from('daily_revenue_logs')
      .select('*, treatment:treatment_id(name, price, duration), employee:employee_id(full_name)')
      .gte('created_at', from)
      .lte('created_at', to)
      .order('created_at', { ascending: false })

    if (!isManager) {
      query = query.eq('employee_id', user.id)
    } else if (selectedLocationId && selectedLocationId !== 'all') {
      query = query.eq('location_id', selectedLocationId)
    }

    const { data } = await query
    return data ?? []
  }

  // ── Computed helpers ─────────────────────────────────────────────────────────

  function periodLabel() {
    const fmtD = d => new Date(d + 'T12:00:00').toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })
    if (dateFrom !== dateTo) return `${fmtD(dateFrom)} – ${fmtD(dateTo)}`
    return dateFrom === localDate() ? 'heute' : fmtD(dateFrom)
  }

  function locationTreatments() {
    let result = (selectedLocationId && selectedLocationId !== 'all')
      ? treatments.filter(t => !t.location_id || t.location_id === selectedLocationId)
      : treatments
    const seen = new Set()
    return result.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true })
  }

  function todaySummary() {
    const active  = todayLogs.filter(l => !l.is_cancelled)
    const real    = active.filter(l => !l.is_no_show)
    const noShows = active.filter(l => l.is_no_show)
    const revenue = real.reduce((s, l) => s + Number(l.revenue), 0)
    const tips    = active.reduce((s, l) => s + Number(l.tip), 0)
    return { total: active.length, noShows: noShows.length, revenue, tips }
  }

  function canEdit(log) {
    if (log.is_cancelled) return false
    const ld = new Date(log.created_at)
    const logDate = `${ld.getFullYear()}-${String(ld.getMonth()+1).padStart(2,'0')}-${String(ld.getDate()).padStart(2,'0')}`
    if (logDate !== localDate()) return false
    if (isManager) return true
    return log.employee_id === user.id
  }

  function cancellerName(id) {
    if (!id) return null
    if (id === user.id) return user.profile?.full_name ?? 'Admin'
    return employees.find(e => e.id === id)?.full_name ?? null
  }

  // ── Arbeitszeit-Anzeigezeile ──────────────────────────────────────────────────

  function buildHoursDisplayLine(entry) {
    if (!entry) return ''
    const hw       = entry.hours_worked ?? 0
    const h        = Math.floor(hw)
    const m        = Math.round((hw - h) * 60)
    const locName  = entry.location ?? locations.find(l => l.id === entry.location_id)?.name ?? ''
    const lunchMin = entry.lunch_break_minutes ?? entry.break_minutes ?? 0
    const locPart  = locName ? ` | ${locName}` : ''
    const pauseStr = lunchMin > 0 ? `${lunchMin} Min. Pause` : 'Keine Pause'
    const workStr  = m > 0 ? `${h} Std. ${m} Min. gearbeitet` : `${h} Std. gearbeitet`
    return `${workStr}${locPart} | ${pauseStr}`
  }

  // ── Save / delete ─────────────────────────────────────────────────────────────

  async function saveLog(data, logId = null) {
    if (selectedLocationId === 'all') {
      showToast('Bitte zuerst einen konkreten Standort auswählen.', 'error')
      return false
    }
    if (!logId && dateFrom !== localDate()) {
      showToast('Historische Ansicht – neue Einträge nur für heute möglich.', 'error')
      return false
    }
    const treatment  = treatments.find(t => t.id === data.treatment_id)
    const isNoShow   = !!data.is_no_show
    const upsell     = isNoShow ? 0 : Math.max(0, Number(data.upsell_amount) || 0)
    const tip        = isNoShow ? 0 : Math.max(0, Number(data.tip) || 0)
    const revenue    = isNoShow ? 0 : (
      data._overrideRevenue !== undefined
        ? Math.max(0, Number(data._overrideRevenue)) + upsell
        : Number(treatment?.price ?? 0) + upsell
    )
    const employeeId = data.employee_id ?? user.id

    const payload = {
      employee_id:      employeeId,
      location_id:      selectedLocationId,
      treatment_id:     data.treatment_id,
      revenue,
      upsell_amount:    upsell,
      tip,
      is_no_show:       isNoShow,
      payment_method:   data.payment_method ?? 'bar',
      created_by:       user.id,
      payment_method_2: data.payment_method_2 ?? null,
      amount_method_1:  data.amount_method_1  ?? revenue,
      amount_method_2:  data.amount_method_2  ?? 0,
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
          treatment: { name: data._customTreatmentName ?? treatment?.name, price: treatment?.price ?? 0 },
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

  async function cancelLog(logId) {
    const log = todayLogs.find(l => l.id === logId)
    if (!log || !canEdit(log)) {
      showToast('Nur am selben Tag stornierbar.', 'error')
      return
    }
    if (!confirm('Eintrag wirklich stornieren?\n\nDer Eintrag bleibt sichtbar und wird als storniert markiert.')) return

    const { error } = await supabase
      .from('daily_revenue_logs')
      .update({ is_cancelled: true, cancelled_at: new Date().toISOString(), cancelled_by: user.id })
      .eq('id', logId)
    if (error) { showToast('Fehler: ' + error.message, 'error'); return }
    showToast('Eintrag storniert.')
    todayLogs = todayLogs.map(l => l.id === logId ? { ...l, is_cancelled: true, cancelled_by: user.id } : l)
    rerender()
    await refreshLogs()
  }

  async function refreshLogs() {
    todayLogs = await fetchTodayLogs()
    rerender()
  }

  async function refreshDay() {
    todayLogs = await fetchTodayLogs()
    const dt = dateFrom
    if (isManager) {
      const { data: hData } = await supabase.from('employee_daily_hours').select('*').eq('date', dt)
      teamHoursMap = Object.fromEntries((hData ?? []).map(h => [h.employee_id, h]))
    } else {
      const { data: hData } = await supabase.from('employee_daily_hours').select('*')
        .eq('employee_id', user.id).eq('date', dt).maybeSingle()
      hoursToday = hData ?? null
    }
    rerender()
  }

  // saveHours: speichert Gesamtstunden (Dezimalzahl) + Pause + Standort
  async function saveHours({
    totalHours     = 8,
    lunchBreakMins = 0,
    locationId     = null,
    locationName   = null,
    isManualEdit   = false,
  } = {}) {
    const today = localDate()
    const h     = Math.max(0, totalHours)
    const b     = Math.max(0, lunchBreakMins)

    const payload = {
      employee_id:         user.id,
      date:                today,
      hours_worked:        h,
      break_minutes:       b,
      lunch_break_minutes: b,
      location_id:         locationId,
      location:            locationName,
    }

    if (isManualEdit && hoursToday) {
      payload.is_modified = true
      if (!hoursToday.is_modified) {
        payload.original_hours = buildHoursDisplayLine(hoursToday)
      }
    }

    let data, error
    try {
      const r1 = await supabase
        .from('employee_daily_hours')
        .upsert(payload, { onConflict: 'employee_id,date' })
        .select().single()
      data  = r1.data
      error = r1.error
    } catch (err) {
      showToast('Fehler: ' + (err?.message || 'Unbekannter Fehler'), 'error')
      return false
    }

    if (error) { showToast('Fehler: ' + error.message, 'error'); return false }
    hoursToday = data
    showToast('Arbeitszeit gespeichert.')
    rerender()
    return true
  }

  // ── Arbeitszeit-Erfassungs-Formular ───────────────────────────────────────────

  function openHoursFormModal() {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:16px;box-sizing:border-box'

    // Erlaubte Studios aus Mitarbeiterprofil – kein Fallback, leeres Array = kein Zugriff
    const empStudios  = user?.profile?.assigned_studios ?? []
    const allowedLocs = locations.filter(l => empStudios.some(s => s.toLowerCase() === l.name.toLowerCase()))
    const singleLoc   = allowedLocs.length === 1 ? allowedLocs[0] : null

    const isEdit     = !!hoursToday
    const existHW    = hoursToday?.hours_worked ?? 8
    const existH     = Math.floor(existHW)
    const existMRaw  = Math.round((existHW - existH) * 60)
    // Auf 15-Minuten-Raster runden
    const existM     = Math.round(existMRaw / 15) * 15 < 60
      ? Math.round(existMRaw / 15) * 15
      : 45
    const curLunch   = hoursToday?.lunch_break_minutes ?? hoursToday?.break_minutes ?? 0
    const curLocId   = hoursToday?.location_id ?? null
    const curLocName = hoursToday?.location    ?? null

    // Stunden-Optionen: 0–14
    const HOUR_OPTS  = Array.from({ length: 15 }, (_, i) => i)
    // Minuten-Optionen: 00, 15, 30, 45
    const MIN_OPTS   = [0, 15, 30, 45]
    const LUNCH_OPTS = [
      { value: 0,  label: 'Keine Pause' },
      { value: 15, label: '15 Min'      },
      { value: 30, label: '30 Min'      },
      { value: 45, label: '45 Min'      },
      { value: 60, label: '60 Min'      },
    ]

    const selectStyle = 'padding:10px 8px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:1rem;font-weight:700;color:var(--aubergine);background:var(--white);text-align:center;-webkit-appearance:auto;cursor:pointer'

    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:360px;width:100%;max-height:92vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:18px 20px 0">
          <h3 style="margin:0;font-size:1.05rem;color:var(--aubergine)">${isEdit ? 'Arbeitszeit bearbeiten' : 'Arbeitszeit erfassen'}</h3>
          <button id="hf-close" style="background:none;border:none;font-size:0.85rem;cursor:pointer;color:var(--text-light);padding:4px 8px;font-weight:700">X</button>
        </div>

        <div style="padding:16px 20px;display:flex;flex-direction:column;gap:18px">

          <!-- A) Standort -->
          ${empStudios.length === 0 ? `
            <div style="background:#fdecea;border-radius:var(--radius-sm);padding:10px 14px;font-size:0.85rem;color:#8b2e1a;border:1px solid var(--terracotta)">
              Kein Studio zugewiesen
            </div>
          ` : singleLoc ? `
            <div style="background:var(--cream-dark);border-radius:var(--radius-sm);padding:10px 14px;font-size:0.85rem;color:var(--text-mid)">
              Standort: <strong style="color:var(--aubergine)">${singleLoc.name}</strong>
            </div>
          ` : `
            <div>
              <div style="font-size:0.85rem;font-weight:600;color:var(--text-mid);margin-bottom:8px">
                Standort <span style="color:var(--terracotta)">*</span>
              </div>
              <div style="display:flex;flex-direction:column;gap:6px">
                ${allowedLocs.map(l => {
                  const sel = curLocName === l.name || curLocId === l.id
                  return `
                    <button type="button" class="hf-loc-btn" data-id="${l.id}" data-name="${l.name}"
                      style="padding:10px 14px;border:2px solid ${sel ? 'var(--aubergine)' : 'var(--cream-dark)'};border-radius:var(--radius-sm);background:${sel ? 'var(--cream)' : 'var(--white)'};font-size:0.92rem;cursor:pointer;color:${sel ? 'var(--aubergine)' : 'var(--text-mid)'};text-align:left;transition:all 0.15s;font-weight:${sel ? '700' : '400'}">
                      ${l.name}
                    </button>`
                }).join('')}
              </div>
            </div>
          `}

          <!-- B) Reine Arbeitszeit: Stunden + Minuten nebeneinander -->
          <div>
            <div style="font-size:0.85rem;font-weight:600;color:var(--text-mid);margin-bottom:8px">Reine Arbeitszeit</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div style="display:flex;flex-direction:column;gap:4px">
                <span style="font-size:0.75rem;color:var(--text-light);text-align:center">Stunden</span>
                <select id="hf-hours" style="${selectStyle}">
                  ${HOUR_OPTS.map(h => `<option value="${h}" ${h === existH ? 'selected' : ''}>${h} Std.</option>`).join('')}
                </select>
              </div>
              <div style="display:flex;flex-direction:column;gap:4px">
                <span style="font-size:0.75rem;color:var(--text-light);text-align:center">Minuten</span>
                <select id="hf-mins" style="${selectStyle}">
                  ${MIN_OPTS.map(m => `<option value="${m}" ${m === existM ? 'selected' : ''}>${String(m).padStart(2,'0')} Min</option>`).join('')}
                </select>
              </div>
            </div>
          </div>

          <!-- C) Mittagspause -->
          <div>
            <div style="font-size:0.85rem;font-weight:600;color:var(--text-mid);margin-bottom:8px">Mittagspause</div>
            <select id="hf-lunch" style="${selectStyle};width:100%">
              ${LUNCH_OPTS.map(o => `<option value="${o.value}" ${o.value === curLunch ? 'selected' : ''}>${o.label}</option>`).join('')}
            </select>
          </div>

          <!-- Netto-Vorschau -->
          <div style="background:var(--cream-dark);border-radius:var(--radius-sm);padding:10px 14px;text-align:center;font-size:0.85rem;color:var(--text-mid)">
            Netto-Arbeitszeit: <strong id="hf-net" style="color:var(--aubergine);font-size:1rem">–</strong>
          </div>

        </div>

        <div style="padding:0 20px 20px">
          <button id="hf-save" class="btn btn-accent"
            style="width:100%;justify-content:center;${empStudios.length === 0 || (!singleLoc && !curLocId && !curLocName) ? 'opacity:0.45;pointer-events:none' : ''}">
            Arbeitszeit verbindlich speichern
          </button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    const hoursSel = overlay.querySelector('#hf-hours')
    const minsSel  = overlay.querySelector('#hf-mins')
    const lunchSel = overlay.querySelector('#hf-lunch')
    const netDisp  = overlay.querySelector('#hf-net')

    function updateNet() {
      const h     = parseInt(hoursSel.value, 10)
      const m     = parseInt(minsSel.value,  10)
      const lunch = parseInt(lunchSel.value,  10)
      const total = h + m / 60
      const net   = Math.max(0, total - lunch / 60)
      netDisp.textContent = net > 0 ? fmtHours(net) : '0 Std.'
    }
    updateNet()
    hoursSel.addEventListener('change', updateNet)
    minsSel.addEventListener('change',  updateNet)
    lunchSel.addEventListener('change', updateNet)

    overlay.querySelector('#hf-close').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

    let selLocId   = singleLoc?.id   ?? curLocId   ?? null
    let selLocName = singleLoc?.name ?? curLocName ?? null

    function syncSaveBtn() {
      const btn = overlay.querySelector('#hf-save')
      const valid = !!selLocId
      btn.style.opacity       = valid ? '1' : '0.45'
      btn.style.pointerEvents = valid ? ''  : 'none'
    }
    if (!singleLoc) syncSaveBtn()

    overlay.querySelectorAll('.hf-loc-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        selLocId   = btn.dataset.id
        selLocName = btn.dataset.name
        overlay.querySelectorAll('.hf-loc-btn').forEach(b => {
          const on = b.dataset.id === selLocId
          b.style.borderColor = on ? 'var(--aubergine)' : 'var(--cream-dark)'
          b.style.background  = on ? 'var(--cream)'     : 'var(--white)'
          b.style.color       = on ? 'var(--aubergine)' : 'var(--text-mid)'
          b.style.fontWeight  = on ? '700'              : '400'
        })
        syncSaveBtn()
      })
    })

    overlay.querySelector('#hf-save').addEventListener('click', async () => {
      if (!selLocId) {
        showToast('Bitte zuerst einen Standort auswählen.', 'error'); return
      }
      const h     = parseInt(hoursSel.value, 10)
      const m     = parseInt(minsSel.value,  10)
      const total = h + m / 60
      if (total <= 0) {
        showToast('Bitte eine Arbeitszeit von mindestens 15 Minuten angeben.', 'error'); return
      }
      const lunch   = parseInt(lunchSel.value, 10)
      const saveBtn = overlay.querySelector('#hf-save')
      saveBtn.disabled = true
      saveBtn.textContent = 'Wird gespeichert...'

      const ok = await saveHours({
        totalHours:     total,
        lunchBreakMins: lunch,
        locationId:     selLocId,
        locationName:   selLocName,
        isManualEdit:   isEdit,
      })
      if (ok) overlay.remove()
      else {
        saveBtn.disabled = false
        saveBtn.textContent = 'Arbeitszeit verbindlich speichern'
      }
    })
  }

  // ── SOP-Pflichtlektüre Modal ──────────────────────────────────────────────────

  function showMandatorySopModal(sopList, onAllRead) {
    const sop  = sopList[0]
    const rest = sopList.slice(1)

    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:10000;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.72);box-sizing:border-box'

    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg) var(--radius-lg) 0 0;max-width:520px;width:100%;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 -10px 40px rgba(0,0,0,0.3)">
        <div style="padding:16px 20px 14px;border-bottom:1px solid var(--cream-dark)">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div>
              <span style="font-size:0.68rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--terracotta)">Pflichtlektüre</span>
              <h3 style="margin:6px 0 0;color:var(--aubergine);font-size:1rem;line-height:1.3">${sop.title}</h3>
            </div>
            ${rest.length > 0 ? `<span style="font-size:0.75rem;color:var(--text-light);white-space:nowrap;margin-left:12px;padding-top:4px">noch ${rest.length}</span>` : ''}
          </div>
          <p style="margin:8px 0 0;font-size:0.8rem;color:var(--text-mid)">Bitte lies diese SOP vollständig, bevor du deine Schicht startest.</p>
        </div>
        <div style="flex:1;overflow-y:auto;padding:16px 20px;font-size:0.875rem;color:var(--text-mid);line-height:1.75">
          ${sop.content ? sop.content.replace(/\n/g, '<br>') : '<em style="color:var(--text-light)">Kein Inhalt</em>'}
        </div>
        <div style="padding:16px 20px;border-top:1px solid var(--cream-dark)">
          <button id="sop-confirm-btn" class="btn btn-accent" style="width:100%;justify-content:center;background:var(--terracotta);border-color:var(--terracotta)">
            Gelesen und Verstanden
          </button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    overlay.querySelector('#sop-confirm-btn').addEventListener('click', async () => {
      const btn = overlay.querySelector('#sop-confirm-btn')
      btn.disabled    = true
      btn.textContent = 'Wird gespeichert...'
      await supabase.from('sop_reads').insert({ sop_id: sop.id, employee_id: user.id, read_at: new Date().toISOString() })
      overlay.remove()
      if (rest.length > 0) showMandatorySopModal(rest, onAllRead)
      else onAllRead()
    })
  }

  // ── UI-Bausteine ──────────────────────────────────────────────────────────────

  function buildMyHoursCard() {
    if (isManager) return ''

    let timeStr = '–'
    let subLine = ''

    if (hoursToday) {
      timeStr = fmtHours(hoursToday.hours_worked ?? 0)
      const lunchMin  = hoursToday.lunch_break_minutes ?? hoursToday.break_minutes ?? 0
      const locName   = hoursToday.location ?? locations.find(l => l.id === hoursToday.location_id)?.name ?? ''
      const treatMins = todayLogs
        .filter(l => !l.is_cancelled && !l.is_no_show)
        .reduce((s, l) => s + Number(l.treatment?.duration ?? treatments.find(t => t.id === l.treatment_id)?.duration ?? 60), 0)
      const netMins = Math.max(1, (hoursToday.hours_worked ?? 0) * 60 - lunchMin)
      const util    = Math.round((treatMins / netMins) * 100)
      const uCol    = util >= 80 ? '#27AE60' : util >= 50 ? 'var(--gold)' : 'var(--terracotta)'
      const netH    = Math.max(0, (hoursToday.hours_worked ?? 0) - lunchMin / 60)
      subLine = `
        <div style="font-size:0.78rem;color:var(--text-mid);margin-top:4px">
          Netto: <strong style="color:var(--aubergine)">${fmtHours(netH)}</strong>
          &nbsp;&middot;&nbsp; Auslastung: <strong style="color:${uCol}">${util}%</strong>
          ${locName ? `&nbsp;&middot;&nbsp; <strong style="color:var(--aubergine)">${locName}</strong>` : ''}
          &nbsp;&middot;&nbsp; ${lunchMin > 0 ? lunchMin + ' Min. Pause' : 'Keine Pause'}
        </div>`
    }

    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;margin-bottom:16px;background:var(--cream);border-radius:var(--radius-md)">
        <div>
          <div style="font-size:0.65rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-light);margin-bottom:5px">Heute erfasst</div>
          <div style="font-size:1.45rem;font-weight:700;color:var(--aubergine);line-height:1.2">${timeStr}</div>
          ${subLine}
        </div>
        <button id="btn-log-hours" class="btn btn-ghost btn-sm" style="flex-shrink:0;padding:7px 13px;font-size:0.82rem">Bearbeiten</button>
      </div>
    `
  }

  function buildHoursBanner() {
    if (!hoursToday) {
      return `
        <button id="btn-hours-banner" style="
          display:flex;align-items:center;justify-content:space-between;
          width:100%;padding:14px 18px;margin-bottom:20px;
          border:none;border-radius:var(--radius-md);cursor:pointer;
          background:var(--terracotta);color:#fff;
          box-shadow:0 2px 10px rgba(0,0,0,0.18);
        ">
          <span style="font-size:0.95rem;font-weight:700">Arbeitszeit für heute erfassen</span>
          <span style="font-size:0.8rem;opacity:0.85">Tippen zum Eintragen</span>
        </button>
      `
    }

    const lunchMin  = hoursToday.lunch_break_minutes ?? hoursToday.break_minutes ?? 0
    const netH      = Math.max(0, (hoursToday.hours_worked ?? 0) - lunchMin / 60)
    const locName   = hoursToday.location ?? locations.find(l => l.id === hoursToday.location_id)?.name ?? ''

    return `
      <div style="
        display:flex;align-items:center;justify-content:space-between;
        width:100%;padding:14px 18px;margin-bottom:20px;
        border-radius:var(--radius-md);background:#27AE60;color:#fff;
        box-shadow:0 2px 10px rgba(0,0,0,0.18);
      ">
        <span style="font-size:0.95rem;font-weight:700">Arbeitszeit erfasst</span>
        <span style="font-size:0.8rem;opacity:0.9">${fmtHours(hoursToday.hours_worked ?? 0)}${locName ? ' · ' + locName : ''} · Netto ${fmtHours(netH)}</span>
      </div>
    `
  }

  // ── Behandlungs-Modal ─────────────────────────────────────────────────────────

  const PAYMENT_METHODS = [
    { value: 'bar',       label: 'Bar'          },
    { value: 'ec',        label: 'EC-Karte'     },
    { value: 'paypal',    label: 'PayPal'        },
    { value: 'online',    label: 'Online vorab' },
    { value: 'gutschein', label: 'Gutschein'    },
  ]

  function openModal(treatment, existingLog = null, isCustom = false) {
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
    const curPay   = existingLog?.payment_method ?? ''
    const curEmpId = existingLog?.employee_id ?? user.id

    let activeTreatment = treatment ?? {}
    const availableTreats = locationTreatments()
    const currentLocName  = (selectedLocationId && selectedLocationId !== 'all')
      ? (locations.find(l => l.id === selectedLocationId)?.name ?? null)
      : null
    const locNameLower    = currentLocName?.toLowerCase() ?? null
    const filteredByLoc   = locNameLower
      ? employees.filter(e => (e.assigned_studios ?? []).some(s => s.toLowerCase() === locNameLower))
      : employees
    const modalEmployees  = filteredByLoc

    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:420px;width:100%;max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3)">

        <div style="display:flex;justify-content:space-between;align-items:center;padding:18px 20px 0">
          ${isCustom
            ? `<div style="flex:1"><div style="font-size:0.72rem;color:var(--text-light);margin-bottom:3px">Behandlungsname</div><input id="modal-custom-name" type="text" placeholder="Sonstige" maxlength="80" style="width:100%;background:transparent;border:none;border-bottom:2px solid var(--aubergine);outline:none;font-size:1.05rem;font-weight:700;color:var(--aubergine);padding:0 0 3px;font-family:inherit"></div>`
            : `<h3 style="margin:0;font-size:1.05rem;color:var(--aubergine)">${isEdit ? 'Eintrag bearbeiten' : (activeTreatment.name ?? 'Behandlung')}</h3>`
          }
          <button id="modal-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-light);line-height:1;padding:4px">✕</button>
        </div>

        ${isEdit && isManager ? `
        <div style="margin:12px 20px 0;display:flex;align-items:center;background:var(--cream-dark);border-radius:var(--radius-sm);padding:10px 14px">
          <select id="modal-treatment"
            style="flex:1;background:transparent;border:none;outline:none;font-size:0.92rem;color:var(--aubergine);font-weight:600;cursor:pointer">
            ${availableTreats.map(t => `<option value="${t.id}" ${t.id === activeTreatment.id ? 'selected' : ''}>${t.name}</option>`).join('')}
          </select>
        </div>
        ` : ''}

        <div style="margin:8px 20px 0;display:flex;justify-content:space-between;align-items:center;background:var(--cream-dark);border-radius:var(--radius-sm);padding:10px 14px">
          <span style="font-size:0.85rem;color:var(--text-mid)">Behandlungspreis</span>
          ${isCustom
            ? `<input id="modal-custom-price" type="number" min="0" step="0.01" placeholder="0.00" style="background:transparent;border:none;border-bottom:2px solid var(--aubergine);outline:none;font-size:1.05rem;font-weight:700;color:var(--aubergine);text-align:right;width:110px;padding:0 0 2px;font-family:inherit">`
            : `<strong id="modal-price-val" style="color:var(--aubergine);font-size:1.05rem">${fmt(activeTreatment.price ?? 0)}</strong>`
          }
        </div>

        <div style="padding:14px 20px;display:flex;flex-direction:column;gap:12px">

          ${isManager ? `
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Durchgeführt von <span style="color:var(--terracotta);font-weight:700">*</span>
            <select id="modal-employee" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;background:var(--white)">
              <option value="">– Mitarbeiter wählen –</option>
              ${modalEmployees.map(e => `<option value="${e.id}" ${e.id === curEmpId ? 'selected' : ''}>${e.full_name}</option>`).join('')}
            </select>
          </label>
          ` : ''}

          <div>
            <div style="font-size:0.85rem;color:var(--text-mid);margin-bottom:6px">Zahlungsart${!existingLog ? ' <span style="color:var(--terracotta);font-weight:700">*</span>' : ''}</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${PAYMENT_METHODS.map(({ value, label }) => {
                const active = curPay === value
                return `<button type="button" class="pay-btn" data-pay="${value}"
                  style="padding:7px 12px;border:2px solid ${active ? 'var(--aubergine)' : 'var(--cream-dark)'};border-radius:var(--radius-sm);background:${active ? 'var(--cream)' : 'var(--white)'};font-size:0.82rem;cursor:pointer;font-weight:${active ? '600' : '400'};color:${active ? 'var(--aubergine)' : 'var(--text-mid)'};transition:all 0.15s">
                  ${label}
                </button>`
              }).join('')}
            </div>
            <button type="button" id="btn-split-toggle" style="margin-top:10px;background:none;border:1px dashed var(--cream-dark);border-radius:var(--radius-sm);padding:6px 12px;font-size:0.78rem;color:var(--text-mid);cursor:pointer;width:100%;text-align:left;transition:all 0.15s">
              ➔ Zahlung aufteilen (Split)
            </button>
            <div id="split-section" style="display:none">
              <div style="margin-top:10px;padding:12px;background:var(--cream);border-radius:var(--radius-sm);display:flex;flex-direction:column;gap:10px">
                <div style="display:grid;grid-template-columns:1fr 100px;gap:8px;align-items:center">
                  <span style="font-size:0.82rem;color:var(--text-mid)">Betrag Zahlungsart 1 (€)</span>
                  <input id="split-amt-1" type="number" min="0" step="0.01" value="0"
                    style="padding:7px 8px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;text-align:right;font-weight:600">
                </div>
                <div style="display:flex;flex-direction:column;gap:6px">
                  <span style="font-size:0.82rem;color:var(--text-mid)">Zahlungsart 2 <span style="color:var(--terracotta);font-weight:700">*</span></span>
                  <div style="display:grid;grid-template-columns:1fr 100px;gap:8px;align-items:center">
                    <select id="split-method-2" style="padding:8px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.87rem;background:var(--white);color:var(--aubergine)">
                      <option value="">-- Bitte wählen --</option>
                      ${PAYMENT_METHODS.map(({ value, label }) => `<option value="${value}">${label}</option>`).join('')}
                    </select>
                    <input id="split-amt-2" type="number" min="0" step="0.01" value="0" readonly
                      style="padding:7px 8px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;text-align:right;background:var(--cream-dark);color:var(--text-mid);font-weight:600">
                  </div>
                </div>
              </div>
            </div>
          </div>

          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Zusatzverkauf (€)
            <input id="modal-upsell" type="number" min="0" step="0.01" value="${upsell}"
              style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:1rem;${isNS ? 'opacity:0.4;pointer-events:none' : ''}">
          </label>

          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Trinkgeld (€)
            <input id="modal-tip" type="number" min="0" step="0.01" value="${tip}"
              style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:1rem;${isNS ? 'opacity:0.4;pointer-events:none' : ''}">
          </label>

          <label id="noshow-label" style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:0.9rem;padding:10px;background:${isNS ? 'rgba(181,87,58,0.08)' : 'transparent'};border-radius:var(--radius-sm);transition:background 0.15s">
            <input id="modal-noshow" type="checkbox" ${isNS ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--terracotta)">
            No-Show
          </label>

          <div style="font-size:0.8rem;color:var(--text-light);text-align:right">
            Umsatz: <strong id="modal-rev-val">${fmt(isEdit ? existingLog.revenue : (isCustom ? 0 : (activeTreatment.price ?? 0)))}</strong>
          </div>
        </div>

        <div style="padding:0 20px 20px;display:flex;gap:8px">
          ${isEdit ? `<button id="modal-delete" class="btn" style="background:var(--terracotta);color:#fff;flex:0 0 auto">Stornieren</button>` : ''}
          <button id="modal-save" class="btn btn-accent" style="flex:1">Speichern</button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    // Frischer Mitarbeiter-Fetch beim Modal-Öffnen – alle Profile laden, JS-seitig filtern
    if (isManager) {
      const empSelect = overlay.querySelector('#modal-employee')
      if (empSelect) {
        ;(async () => {
          const { data } = await supabase.from('profiles').select('*').eq('is_active', true)
          const all      = (data ?? []).filter(p => p.full_name && (p.assigned_studios ?? []).length > 0)
          const toShow   = locNameLower
            ? all.filter(p => (p.assigned_studios ?? []).map(s => s.toLowerCase()).includes(locNameLower))
            : all
          empSelect.innerHTML =
            '<option value="">– Mitarbeiter wählen –</option>' +
            toShow.map(e =>
              `<option value="${e.id}" ${e.id === curEmpId ? 'selected' : ''}>${e.full_name}</option>`
            ).join('')
        })()
      }
    }

    const upsellInput  = overlay.querySelector('#modal-upsell')
    const tipInput     = overlay.querySelector('#modal-tip')
    const nsCheckbox   = overlay.querySelector('#modal-noshow')
    const noshowLabel  = overlay.querySelector('#noshow-label')
    const revVal       = overlay.querySelector('#modal-rev-val')
    const priceVal     = overlay.querySelector('#modal-price-val')
    const treatSelect  = overlay.querySelector('#modal-treatment')
    const splitSection = overlay.querySelector('#split-section')
    const splitToggle  = overlay.querySelector('#btn-split-toggle')
    const splitAmt1    = overlay.querySelector('#split-amt-1')
    const splitAmt2    = overlay.querySelector('#split-amt-2')
    const splitMethod2 = overlay.querySelector('#split-method-2')
    let splitActive        = !!existingLog?.payment_method_2
    const customNameInput  = overlay.querySelector('#modal-custom-name')
    const customPriceInput = overlay.querySelector('#modal-custom-price')

    treatSelect?.addEventListener('change', () => {
      activeTreatment = availableTreats.find(t => t.id === treatSelect.value) ?? activeTreatment
      priceVal.textContent = fmt(activeTreatment.price ?? 0)
      updatePreview()
    })

    let selectedPayment = curPay
    const saveBtn = overlay.querySelector('#modal-save')

    function syncSaveBtn() {
      const valid = !!selectedPayment
      saveBtn.style.opacity       = valid ? '1' : '0.45'
      saveBtn.style.cursor        = valid ? '' : 'not-allowed'
      saveBtn.style.pointerEvents = valid ? '' : 'none'
    }
    if (!existingLog) syncSaveBtn()

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
        if (!existingLog) syncSaveBtn()
      })
    })

    function updatePreview() {
      const ns    = nsCheckbox.checked
      const u     = ns ? 0 : Math.max(0, parseFloat(upsellInput.value) || 0)
      const price = isCustom
        ? Math.max(0, parseFloat(customPriceInput?.value) || 0)
        : (activeTreatment.price ?? 0)
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

    function getTotalForSplit() {
      const ns    = nsCheckbox.checked
      if (ns) return 0
      const u     = Math.max(0, parseFloat(upsellInput.value) || 0)
      const price = isCustom
        ? Math.max(0, parseFloat(customPriceInput?.value) || 0)
        : (activeTreatment.price ?? 0)
      return price + u
    }

    function autoCalcAmt2() {
      if (!splitActive || !splitAmt1 || !splitAmt2) return
      const total = getTotalForSplit()
      const a1    = Math.max(0, parseFloat(splitAmt1.value) || 0)
      splitAmt2.value = Math.max(0, total - a1).toFixed(2)
    }

    splitToggle?.addEventListener('click', () => {
      splitActive = !splitActive
      splitSection.style.display    = splitActive ? 'block' : 'none'
      splitToggle.textContent       = splitActive ? '✖ Splitzahlung aktiv' : '➔ Zahlung aufteilen (Split)'
      splitToggle.style.background  = splitActive ? 'rgba(181,87,58,0.08)' : 'none'
      splitToggle.style.color       = splitActive ? 'var(--terracotta)' : 'var(--text-mid)'
      splitToggle.style.borderColor = splitActive ? 'var(--terracotta)' : 'var(--cream-dark)'
      if (splitActive) {
        const total = getTotalForSplit()
        splitAmt1.value = total.toFixed(2)
        splitAmt2.value = '0.00'
      }
    })
    splitAmt1?.addEventListener('input', autoCalcAmt2)
    upsellInput.addEventListener('input', autoCalcAmt2)
    nsCheckbox.addEventListener('change', autoCalcAmt2)
    customPriceInput?.addEventListener('input', updatePreview)
    customPriceInput?.addEventListener('input', autoCalcAmt2)

    if (splitActive && splitSection) {
      splitSection.style.display    = 'block'
      splitToggle.textContent       = '✖ Splitzahlung aktiv'
      splitToggle.style.background  = 'rgba(181,87,58,0.08)'
      splitToggle.style.color       = 'var(--terracotta)'
      splitToggle.style.borderColor = 'var(--terracotta)'
      if (existingLog?.amount_method_1 != null) splitAmt1.value = Number(existingLog.amount_method_1).toFixed(2)
      if (existingLog?.amount_method_2 != null) splitAmt2.value = Number(existingLog.amount_method_2).toFixed(2)
      if (splitMethod2 && existingLog?.payment_method_2) splitMethod2.value = existingLog.payment_method_2
    }

    overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

    overlay.querySelector('#modal-save').addEventListener('click', async () => {
      if (!existingLog && !selectedPayment) {
        alert('Bitte wähle eine Zahlungsart (Bar, EC, PayPal...) aus, bevor du speicherst!')
        return
      }
      const rawEmpId = overlay.querySelector('#modal-employee')?.value
      if (isManager && !rawEmpId) {
        showToast('Bitte wähle eine Mitarbeiterin aus.', 'error')
        return
      }
      const empId = rawEmpId || user.id
      const ns    = nsCheckbox.checked
      const u     = ns ? 0 : Math.max(0, parseFloat(upsellInput.value) || 0)
      const t     = ns ? 0 : Math.max(0, parseFloat(tipInput.value) || 0)

      if (u < 0 || t < 0) { showToast('Keine negativen Beträge.', 'error'); return }

      const customName  = isCustom ? (customNameInput?.value.trim() || 'Sonstige') : undefined
      const customPrice = isCustom ? Math.max(0, parseFloat(customPriceInput?.value) || 0) : undefined
      const basePrice   = isCustom ? customPrice : (activeTreatment.price ?? 0)
      const totalRev    = ns ? 0 : basePrice + u
      let splitM2 = null, splitA1 = totalRev, splitA2 = 0
      if (splitActive) {
        splitM2 = splitMethod2?.value || null
        splitA1 = parseFloat(splitAmt1?.value) || 0
        splitA2 = parseFloat(splitAmt2?.value) || 0
        if (!splitM2) {
          alert('Bitte wähle eine zweite Zahlungsart für die Splitzahlung aus.')
          return
        }
        if (splitM2 === selectedPayment) {
          alert('Beide Zahlungsarten dürfen nicht identisch sein.')
          return
        }
        if (Math.abs(splitA1 + splitA2 - totalRev) > 0.01) {
          alert(`Die Teilbeträge (${(splitA1 + splitA2).toFixed(2).replace('.', ',')} €) müssen zusammen dem Gesamtpreis (${totalRev.toFixed(2).replace('.', ',')} €) entsprechen.`)
          return
        }
      }

      const saveBtnEl = overlay.querySelector('#modal-save')
      saveBtnEl.disabled = true
      saveBtnEl.textContent = 'Speichern...'

      const ok = await saveLog({
        treatment_id:         isCustom ? null : activeTreatment.id,
        _customTreatmentName: customName,
        _overrideRevenue:     customPrice,
        upsell_amount:        u,
        tip:                  t,
        is_no_show:           ns,
        payment_method:       selectedPayment,
        employee_id:          empId,
        payment_method_2:     splitM2,
        amount_method_1:      splitA1,
        amount_method_2:      splitA2,
      }, existingLog?.id)

      if (ok) overlay.remove()
      else { saveBtnEl.disabled = false; saveBtnEl.textContent = 'Speichern' }
    })

    overlay.querySelector('#modal-delete')?.addEventListener('click', () => {
      overlay.remove()
      cancelLog(existingLog.id)
    })
  }

  // ── Kassensturz & Team-Status ─────────────────────────────────────────────────

  function buildKassensturz() {
    if (!isManager) return ''
    const METHODS = [
      { key: 'bar',       label: 'Bar'          },
      { key: 'ec',        label: 'EC-Karte'     },
      { key: 'paypal',    label: 'PayPal'        },
      { key: 'online',    label: 'Online vorab' },
      { key: 'gutschein', label: 'Gutschein'    },
    ]
    const byPayment = {}
    for (const log of todayLogs.filter(l => !l.is_no_show && !l.is_cancelled)) {
      if (log.payment_method_2) {
        const pm1 = log.payment_method ?? 'bar'
        const pm2 = log.payment_method_2
        byPayment[pm1] = (byPayment[pm1] ?? 0) + Number(log.amount_method_1 ?? 0)
        byPayment[pm2] = (byPayment[pm2] ?? 0) + Number(log.amount_method_2 ?? 0)
      } else {
        const pm = log.payment_method ?? 'bar'
        byPayment[pm] = (byPayment[pm] ?? 0) + Number(log.revenue)
      }
    }
    const noShowLoss = todayLogs
      .filter(l => l.is_no_show && !l.is_cancelled)
      .reduce((s, l) => s + Number(l.treatment?.price ?? 0), 0)

    return `
      <div class="card" style="margin-bottom:16px;background:var(--aubergine);border:none">
        <div style="padding:14px 18px 8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
          <span style="font-size:0.75rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:rgba(245,237,228,0.55)">Kassensturz (${period === 'week' ? 'Woche' : period === 'month' ? 'Monat' : 'Heute'})</span>
          ${noShowLoss > 0
            ? `<span style="font-size:0.78rem;color:rgba(245,237,228,0.7);background:rgba(0,0,0,0.25);padding:3px 10px;border-radius:20px">No-Show Verlust: ${fmt(noShowLoss)}</span>`
            : `<span style="font-size:0.75rem;color:rgba(245,237,228,0.35)">Keine No-Shows</span>`}
        </div>
        <div style="padding:0 18px 14px;display:grid;grid-template-columns:repeat(5,1fr);gap:8px">
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
    for (const log of todayLogs.filter(l => !l.is_cancelled)) {
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
      const dbH       = teamHoursMap[empId]
      const initHours = Number(dbH?.hours_worked ?? 8)
      const initBreak = Number(dbH?.lunch_break_minutes ?? dbH?.break_minutes ?? 0)
      const netMins   = Math.max(1, initHours * 60 - initBreak)
      const split     = Object.entries(d.counts).map(([n, c]) => `${c}× ${n}`).join(' · ') || '–'
      const util      = d.minutes > 0 ? Math.round((d.minutes / netMins) * 100) : 0
      const uCol      = util >= 80 ? '#27AE60' : util >= 50 ? 'var(--gold)' : 'var(--terracotta)'
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
          <div style="display:flex;align-items:center;gap:6px;margin-top:2px;flex-wrap:wrap">
            <span style="font-size:0.75rem;color:var(--text-mid)">Std.:</span>
            <input type="number" min="1" max="24" step="0.5" value="${initHours}"
              class="hours-input" data-emp="${empId}" data-minutes="${d.minutes}"
              style="width:50px;padding:3px 6px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.82rem;text-align:center">
            <span style="font-size:0.75rem;color:var(--text-mid)">Pause:</span>
            <input type="number" min="0" max="180" step="5" value="${initBreak}"
              class="break-input" data-emp="${empId}"
              style="width:50px;padding:3px 6px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.82rem;text-align:center">
            <span class="util-display" data-emp="${empId}" style="font-size:0.82rem;font-weight:700;color:${uCol}">
              Auslastung: ${util}%
            </span>
          </div>
        </div>`
    }).join('')

    return `
      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><h4>Team-Status und Auslastung</h4></div>
        <div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px">${cards}</div>
      </div>`
  }

  // ── HTML-Aufbau ───────────────────────────────────────────────────────────────

  function buildHTML() {
    const summary    = todaySummary()
    const treatsHere = locationTreatments()

    return `
      <div class="page-header">
        <div>
          <h2>Tagesabschluss</h2>
          <p style="color:var(--text-light);font-size:0.875rem">${
            dateFrom === dateTo
              ? new Date(dateFrom + 'T12:00:00').toLocaleDateString('de-DE', { weekday:'long', day:'numeric', month:'long' })
              : new Date(dateFrom + 'T12:00:00').toLocaleDateString('de-DE', { day:'numeric', month:'short' }) + ' – ' + new Date(dateTo + 'T12:00:00').toLocaleDateString('de-DE', { day:'numeric', month:'short' })
          }${dateFrom !== localDate() ? ' · Historische Ansicht' : ''}</p>
        </div>
      </div>

      ${!isManager ? buildHoursBanner() : ''}
      ${buildMyHoursCard()}

      ${isManager ? `
        <div style="margin-bottom:16px;display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px">
            <div class="location-tabs" style="margin:0">
              <button class="location-tab ${period==='today'?'active':''}" data-period="today">Heute</button>
              <button class="location-tab ${period==='week' ?'active':''}" data-period="week">Woche</button>
              <button class="location-tab ${period==='month'?'active':''}" data-period="month">Monat</button>
            </div>
            <label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;color:var(--text-mid)">Von
              <input type="date" id="date-from" value="${dateFrom}" max="${localDate()}"
                style="padding:7px 10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);background:var(--white);font-size:0.875rem;color:var(--aubergine)">
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;color:var(--text-mid)">Bis
              <input type="date" id="date-to" value="${dateTo}" max="${localDate()}"
                style="padding:7px 10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);background:var(--white);font-size:0.875rem;color:var(--aubergine)">
            </label>
          </div>
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px">
            <select id="location-select" style="padding:7px 10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);background:var(--white);font-size:0.875rem;color:var(--aubergine)">
              <option value="all" ${selectedLocationId === 'all' ? 'selected' : ''}>Alle Standorte</option>
              ${locations.map(l => `<option value="${l.id}" ${l.id === selectedLocationId ? 'selected' : ''}>${l.name}</option>`).join('')}
            </select>
          </div>
        </div>
      ` : `
        <div style="margin-bottom:16px;display:flex;flex-wrap:wrap;align-items:center;gap:8px">
          <label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;color:var(--text-mid)">Datum wählen:
            <input type="date" id="employee-date-picker" value="${dateFrom}" max="${localDate()}"
              style="padding:7px 10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);background:var(--white);font-size:0.875rem;color:var(--aubergine)">
          </label>
        </div>
      `}

      ${buildKassensturz()}

      <div class="stat-grid" style="margin-bottom:24px">
        <div class="stat-card">
          <div class="stat-label">${isManager ? `Einträge ${period === 'week' ? 'Woche' : period === 'month' ? 'Monat' : 'heute'}` : 'Einträge am Tag'}</div>
          <div class="stat-value">${summary.total}</div>
          <div class="stat-sub">${summary.noShows} No-Show${summary.noShows !== 1 ? 's' : ''}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">${isManager ? `Umsatz ${period === 'week' ? 'Woche' : period === 'month' ? 'Monat' : 'heute'}` : 'Umsatz am Tag'}</div>
          <div class="stat-value" style="color:var(--aubergine)">${fmt(summary.revenue)}</div>
          <div class="stat-sub">ohne No-Shows und Stornos</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Trinkgeld</div>
          <div class="stat-value" style="color:var(--gold)">${fmt(summary.tips)}</div>
          <div class="stat-sub">${isManager ? `gesamt ${periodLabel()}` : 'gesamt am gewählten Tag'}</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><h4>Behandlung erfassen</h4></div>
        ${dateFrom !== localDate() ? `
          <div class="empty-state" style="padding:28px 20px">
            <span class="empty-state-icon">◉</span>
            <p style="color:var(--text-mid)">Historische Ansicht – neue Einträge können nur für heute erfasst werden.</p>
          </div>
        ` : selectedLocationId === 'all' ? `
          <div class="empty-state" style="padding:28px 20px">
            <span class="empty-state-icon">◉</span>
            <p style="color:var(--text-mid)">Für das Erfassen bitte einen konkreten Standort auswählen.</p>
          </div>
        ` : `
          <div class="treatment-grid">
            <button id="btn-custom-treatment"
              style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:10px 12px;border-radius:var(--radius-md);border:2px solid var(--aubergine);background:var(--cream);cursor:pointer;width:100%;transition:all 0.15s;text-align:left">
              <span style="font-weight:700;color:var(--aubergine);font-size:0.85rem;line-height:1.3">+ Eigene Behandlung erfassen</span>
              <span style="font-size:0.75rem;color:var(--text-mid)">Individueller Name und Preis</span>
            </button>
            ${treatsHere.map(t => `
              <button class="btn-treatment" data-id="${t.id}"
                style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:10px 12px;border-radius:var(--radius-md);border:2px solid var(--cream-dark);background:var(--white);cursor:pointer;width:100%;transition:all 0.15s;text-align:left">
                <span style="font-weight:600;color:var(--aubergine);font-size:0.85rem;line-height:1.3">${t.name}</span>
                <span style="font-size:0.75rem;color:var(--text-mid)">${fmt(t.price)}</span>
              </button>
            `).join('')}
          </div>
          ${!treatsHere.length ? `
            <div style="padding:8px 16px 14px">
              <p style="font-size:0.82rem;color:var(--text-light)">Noch keine Standard-Behandlungen für diesen Standort.${isManager
                ? ` Lege sie im <button id="goto-admin" class="btn btn-ghost btn-sm" style="display:inline;padding:2px 6px">Studio-Admin</button> an.`
                : ' Bitte den Manager, Behandlungen anzulegen.'}</p>
            </div>
          ` : ''}
        `}
      </div>

      ${buildTeamStatus()}

      <div class="card">
        <div class="card-header">
          <h4>${isManager ? (period === 'week' ? 'Einträge diese Woche' : period === 'month' ? 'Einträge diesen Monat' : 'Heutige Einträge') : 'Einträge am Tag'}</h4>
          <span style="font-size:0.78rem;color:var(--text-light)">${todayLogs.length} Einträge</span>
        </div>
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
                ${todayLogs.map(log => {
                  const cancelled   = log.is_cancelled === true
                  const rowOpacity  = cancelled ? 'opacity:0.6' : log.is_no_show ? 'opacity:0.5' : ''
                  const strikeStyle = cancelled ? 'text-decoration:line-through;color:var(--text-light)' : ''
                  return `
                  <tr style="${rowOpacity}">
                    <td style="padding:5px 10px;white-space:nowrap;${strikeStyle || 'color:var(--text-mid)'}">${new Date(log.created_at).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' })}</td>
                    ${isManager ? `<td style="padding:5px 10px;font-size:0.78rem;${strikeStyle || 'color:var(--text-mid)'}">${log.employee?.full_name ?? '–'}</td>` : ''}
                    <td style="padding:5px 10px;${strikeStyle}">
                      ${log.treatment?.name ?? '–'}
                      ${log.is_no_show && !cancelled ? `<span style="font-size:0.65rem;background:var(--terracotta);color:#fff;border-radius:4px;padding:1px 4px;margin-left:3px">NS</span>` : ''}
                      ${cancelled ? `<span style="font-size:0.65rem;background:var(--terracotta);color:#fff;border-radius:4px;padding:1px 5px;margin-left:4px;font-weight:600">Storniert</span>${isManager && log.cancelled_by ? `<span style="font-size:0.65rem;color:var(--text-light);margin-left:4px">(von: ${cancellerName(log.cancelled_by) ?? '–'})</span>` : ''}` : ''}
                    </td>
                    <td style="padding:5px 10px;font-weight:600;${cancelled ? strikeStyle : log.is_no_show ? 'color:var(--text-light)' : 'color:var(--aubergine)'}">${fmt(log.revenue)}</td>
                    <td style="padding:5px 10px;${cancelled ? strikeStyle : 'color:var(--gold)'}">${Number(log.tip) > 0 ? fmt(log.tip) : '–'}</td>
                    <td style="padding:5px 10px">
                      ${canEdit(log) ? `
                        <div style="display:flex;gap:3px">
                          <button class="btn btn-ghost btn-sm btn-edit-log" data-id="${log.id}" style="font-size:0.72rem;padding:3px 6px">✏</button>
                          <button class="btn btn-sm btn-cancel-log" data-id="${log.id}" style="font-size:0.72rem;padding:3px 6px;background:var(--terracotta);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">🗑</button>
                        </div>
                      ` : ''}
                    </td>
                  </tr>
                `}).join('')}
              </tbody>
            </table>
          </div>
        ` : `<div class="empty-state"><span class="empty-state-icon">◉</span><p>Noch keine Einträge heute.</p></div>`}
      </div>

      ${!isManager ? buildHoursHistory() : ''}
    `
  }

  // ── Arbeitszeiten-Historie ────────────────────────────────────────────────────

  function buildHoursHistory() {
    if (isManager || !hoursToday) return ''

    const dateLabel   = new Date(dateFrom + 'T12:00:00').toLocaleDateString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    })
    const currentLine = buildHoursDisplayLine(hoursToday)

    let rowContent
    if (hoursToday.is_modified && hoursToday.original_hours) {
      rowContent = `
        <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-start">
          <span style="text-decoration:line-through;color:var(--terracotta);opacity:0.8;font-size:0.88rem">
            ${dateLabel}: ${hoursToday.original_hours}
          </span>
          <span style="color:#27AE60;font-weight:600;font-size:0.92rem">
            ${dateLabel}: ${currentLine}
          </span>
        </div>`
    } else {
      rowContent = `
        <span style="font-size:0.92rem;color:var(--aubergine);font-weight:600">
          ${dateLabel}: ${currentLine}
        </span>`
    }

    return `
      <div class="card" style="margin-top:24px">
        <div class="card-header">
          <h4>Arbeitszeiten-Historie</h4>
          <span style="font-size:0.78rem;color:var(--text-light)">${dateLabel}</span>
        </div>
        <div style="padding:12px 16px">
          ${rowContent}
        </div>
      </div>
    `
  }

  // ── Events ────────────────────────────────────────────────────────────────────

  function attachEvents() {
    container.querySelectorAll('.location-tab[data-period]').forEach(btn => {
      btn.addEventListener('click', async () => {
        period = btn.dataset.period
        const today = localDate()
        if (period === 'today') {
          dateFrom = today; dateTo = today
        } else if (period === 'week') {
          const anchor = new Date(today + 'T12:00:00')
          const dow = anchor.getDay() || 7
          const mon = new Date(anchor); mon.setDate(anchor.getDate() - dow + 1); mon.setHours(0,0,0,0)
          const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
          dateFrom = mon.toISOString().slice(0,10)
          dateTo   = sun.toISOString().slice(0,10)
        } else {
          const anchor = new Date(today + 'T12:00:00')
          const first  = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
          const last   = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
          dateFrom = first.toISOString().slice(0,10)
          dateTo   = last.toISOString().slice(0,10)
        }
        localStorage.setItem('checkoutPeriod', period)
        await refreshDay()
      })
    })

    container.querySelector('#location-select')?.addEventListener('change', async e => {
      selectedLocationId = e.target.value || 'all'
      localStorage.setItem('selectedLocationId', selectedLocationId)
      todayLogs = await fetchTodayLogs()
      rerender()
    })

    container.querySelector('#date-from')?.addEventListener('change', async e => {
      dateFrom = e.target.value || localDate()
      period = ''
      await refreshDay()
    })
    container.querySelector('#date-to')?.addEventListener('change', async e => {
      dateTo = e.target.value || localDate()
      period = ''
      await refreshDay()
    })

    container.querySelector('#employee-date-picker')?.addEventListener('change', async e => {
      dateFrom = dateTo = e.target.value || localDate()
      period = 'today'
      await refreshDay()
    })

    container.querySelector('#btn-custom-treatment')?.addEventListener('click', () => openModal({}, null, true))

    container.querySelectorAll('.btn-treatment[data-id]').forEach(btn => {
      btn.addEventListener('pointerenter', () => { btn.style.borderColor = 'var(--aubergine)'; btn.style.background = 'var(--cream)' })
      btn.addEventListener('pointerleave', () => { btn.style.borderColor = 'var(--cream-dark)'; btn.style.background = 'var(--white)' })
      btn.addEventListener('click', () => {
        const t = treatments.find(t => t.id === btn.dataset.id)
        if (t) openModal(t)
      })
    })

    container.querySelector('#goto-admin')?.addEventListener('click', () => onNavigate?.('admin'))

    // Arbeitszeit-Formular – Banner (Ersterfassung) mit SOP-Gate
    container.querySelector('#btn-hours-banner')?.addEventListener('click', async () => {
      try {
        const { data: unread } = await supabase.rpc('get_unread_mandatory_articles', { target_employee_id: user.id })
        if (unread && unread.length > 0) {
          showMandatorySopModal(unread, () => openHoursFormModal())
          return
        }
      } catch (_) { /* RPC noch nicht verfügbar */ }
      openHoursFormModal()
    })

    // Bearbeiten-Button im Heute-erfasst-Widget
    container.querySelector('#btn-log-hours')?.addEventListener('click', () => openHoursFormModal())

    container.querySelectorAll('.btn-edit-log[data-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const log = todayLogs.find(l => l.id === btn.dataset.id)
        if (!log) return
        const treatment = treatments.find(t => t.id === log.treatment_id)
          ?? { id: log.treatment_id, name: log.treatment?.name, price: log.treatment?.price ?? 0 }
        openModal(treatment, log)
      })
    })

    container.querySelectorAll('.btn-cancel-log[data-id]').forEach(btn => {
      btn.addEventListener('click', () => cancelLog(btn.dataset.id))
    })

    function recalcUtil(empId) {
      const hoursInput = container.querySelector(`.hours-input[data-emp="${empId}"]`)
      const breakInput = container.querySelector(`.break-input[data-emp="${empId}"]`)
      const display    = container.querySelector(`.util-display[data-emp="${empId}"]`)
      if (!hoursInput || !display) return
      const minutes   = Number(hoursInput.dataset.minutes)
      const hours     = Math.max(0.5, parseFloat(hoursInput.value) || 8)
      const breakMins = Math.max(0, parseFloat(breakInput?.value) || 0)
      const netMins   = Math.max(1, hours * 60 - breakMins)
      const util      = Math.round((minutes / netMins) * 100)
      display.textContent = `Auslastung: ${util}%`
      display.style.color = util >= 80 ? '#27AE60' : util >= 50 ? 'var(--gold)' : 'var(--terracotta)'
    }
    container.querySelectorAll('.hours-input[data-emp]').forEach(input => {
      input.addEventListener('input', () => recalcUtil(input.dataset.emp))
    })
    container.querySelectorAll('.break-input[data-emp]').forEach(input => {
      input.addEventListener('input', () => recalcUtil(input.dataset.emp))
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

// ── Modul-Hilfsfunktionen ─────────────────────────────────────────────────────

function fmt(n) {
  return Number(n ?? 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
}

// Formatiert Dezimalstunden als "X Std. Y Min." (ohne führende 0 bei Y=0)
function fmtHours(decimalHours) {
  const h = Math.floor(decimalHours)
  const m = Math.round((decimalHours - h) * 60)
  if (m === 0) return `${h} Std.`
  return `${h} Std. ${m} Min.`
}

function localDate() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
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
