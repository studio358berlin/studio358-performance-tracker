import { supabase } from '../lib/supabase.js'

export function DailyCheckout({ user, onNavigate }) {
  const isManager = user?.profile?.is_manager || user?.profile?.role === 'manager'

  let locations          = []
  let treatments         = []
  let employees          = []
  let todayLogs          = []
  let selectedLocationId = localStorage.getItem('selectedLocationId') || user?.profile?.location_id || null
  let container          = null
  let hoursToday         = null   // employee's own hours entry for today
  let teamHoursMap       = {}     // manager: employee_id → hours entry
  let dateFrom           = localDate()
  let dateTo             = localDate()
  let period             = localStorage.getItem('checkoutPeriod') || 'today'
  let clockInTime        = localStorage.getItem('clockIn_' + localDate()) || null
  let autoCheckOutTimer  = null

  // ── Date range helper ─────────────────────────────────────────────────────────

  function logDateRange() {
    return {
      from: new Date(dateFrom + 'T00:00:00').toISOString(),
      to:   new Date(dateTo   + 'T23:59:59').toISOString(),
    }
  }

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
        selectedLocationId = 'all'   // managers default to full overview
      } else {
        const slug = user?.profile?.location
        selectedLocationId = locations.find(l => l.slug === slug)?.id ?? locations[0]?.id ?? null
      }
    }

    // Load working-hours entries for the selected date
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
    // selectedLocationId === 'all' → no location filter → all locations

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
    // deduplicate by id — prevents duplicate DB rows from rendering multiple times
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
    const revenue    = isNoShow ? 0 : (Number(treatment?.price ?? 0) + upsell)
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
    if (!isManager) scheduleAutoCheckOut()
  }

  async function saveHours(hours, breakMins, locationOverride = null, isManualEdit = false) {
    const today    = localDate()
    const h        = parseFloat(String(hours)) || 0
    const b        = Math.max(0, parseInt(String(breakMins), 10) || 0)
    const locId    = locationOverride ?? user?.profile?.location_id ?? null

    const payload = {
      employee_id:   user.id,
      date:          today,
      hours_worked:  h,
      break_minutes: b,
      location_id:   locId,
    }

    // Persist clock-in time on initial create (when there's no existing entry)
    if (!hoursToday && clockInTime) {
      payload.clock_in_time = clockInTime
    }

    // Track manual edits via the "Bearbeiten" button
    if (isManualEdit && hoursToday) {
      payload.is_modified = true
      payload.modified_at = new Date().toISOString()
      // Preserve original values only on first modification
      if (!hoursToday.is_modified) {
        payload.original_hours_worked  = hoursToday.hours_worked
        payload.original_break_minutes = hoursToday.break_minutes
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

  function openHoursModal() {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:16px;box-sizing:border-box'

    const curHours = hoursToday?.hours_worked ?? 8
    const curBreak = hoursToday?.break_minutes ?? 30

    const profileLocSlug = user?.profile?.location ?? null
    const profileLocId   = user?.profile?.location_id
      ?? locations.find(l => l.slug === profileLocSlug)?.id
      ?? null
    const curLocId = hoursToday?.location_id ?? profileLocId ?? locations[0]?.id ?? null

    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:340px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:18px 20px 0">
          <h3 style="margin:0;font-size:1.05rem;color:var(--aubergine)">Arbeitszeit erfassen</h3>
          <button id="wh-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-light);line-height:1;padding:4px">✕</button>
        </div>
        <div style="padding:16px 20px;display:flex;flex-direction:column;gap:14px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Arbeitszeit (Stunden)
            <input id="wh-hours" type="number" min="0.5" max="24" step="0.5" value="${curHours}"
              style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:1.1rem;font-weight:600;text-align:center">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Pause (Minuten)
            <input id="wh-break" type="number" min="0" max="180" step="5" value="${curBreak}"
              style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:1.1rem;font-weight:600;text-align:center">
          </label>
          ${locations.length ? `
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Standort
            <select id="wh-location" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;background:var(--white);color:var(--aubergine)">
              ${locations.map(l => `<option value="${l.id}" ${l.id === curLocId ? 'selected' : ''}>${l.name}</option>`).join('')}
            </select>
          </label>
          ` : ''}
          <div style="background:var(--cream-dark);border-radius:var(--radius-sm);padding:10px 14px;text-align:center;font-size:0.85rem;color:var(--text-mid)">
            Netto-Arbeitszeit: <strong id="wh-net" style="color:var(--aubergine)">– Std.</strong>
          </div>
        </div>
        <div style="padding:0 20px 20px">
          <button id="wh-save" class="btn btn-accent" style="width:100%;justify-content:center">Speichern</button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    const hoursInput = overlay.querySelector('#wh-hours')
    const breakInput = overlay.querySelector('#wh-break')
    const netDisplay = overlay.querySelector('#wh-net')

    function updateNet() {
      const h   = Math.max(0, parseFloat(hoursInput.value) || 0)
      const b   = Math.max(0, parseFloat(breakInput.value) || 0)
      netDisplay.textContent = Math.max(0, h - b / 60).toFixed(1) + ' Std.'
    }
    updateNet()
    hoursInput.addEventListener('input', updateNet)
    breakInput.addEventListener('input', updateNet)

    overlay.querySelector('#wh-close').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

    overlay.querySelector('#wh-save').addEventListener('click', async () => {
      const h      = Math.max(0.5, parseFloat(hoursInput.value) || 8)
      const b      = Math.max(0, parseInt(breakInput.value) || 0)
      const locId  = overlay.querySelector('#wh-location')?.value ?? null
      const saveBtn = overlay.querySelector('#wh-save')
      saveBtn.disabled = true; saveBtn.textContent = 'Speichern...'
      const ok = await saveHours(h, b, locId || null, true)  // isManualEdit = true
      if (ok) overlay.remove()
      else { saveBtn.disabled = false; saveBtn.textContent = 'Speichern' }
    })
  }

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
            ✓ Gelesen &amp; Verstanden
          </button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    overlay.querySelector('#sop-confirm-btn').addEventListener('click', async () => {
      const btn = overlay.querySelector('#sop-confirm-btn')
      btn.disabled    = true
      btn.textContent = 'Wird gespeichert…'
      await supabase.from('sop_reads').insert({ sop_id: sop.id, employee_id: user.id, read_at: new Date().toISOString() })
      overlay.remove()
      if (rest.length > 0) showMandatorySopModal(rest, onAllRead)
      else onAllRead()
    })
  }

  async function openClockInModal() {
    try {
      const { data: unread } = await supabase.rpc('get_unread_mandatory_articles', { target_employee_id: user.id })
      if (unread && unread.length > 0) {
        showMandatorySopModal(unread, () => openClockInModal())
        return
      }
    } catch (_) { /* RPC not yet available — proceed without gate */ }

    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:16px;box-sizing:border-box'

    const profileLocSlug = user?.profile?.location ?? null
    const profileLocId   = user?.profile?.location_id
      ?? locations.find(l => l.slug === profileLocSlug)?.id
      ?? null
    const defaultLocId = profileLocId ?? (selectedLocationId !== 'all' ? selectedLocationId : locations[0]?.id ?? null)
    const startStr     = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })

    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:340px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:18px 20px 0">
          <h3 style="margin:0;font-size:1.05rem;color:var(--aubergine)">Schicht starten</h3>
          <button id="ci-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-light);line-height:1;padding:4px">✕</button>
        </div>
        <div style="padding:16px 20px;display:flex;flex-direction:column;gap:14px">
          <div style="background:var(--cream-dark);border-radius:var(--radius-sm);padding:10px 14px;font-size:0.85rem;color:var(--text-mid)">
            Start: <strong style="color:var(--aubergine)">${startStr} Uhr</strong> · 8 Std. / 30 Min. Pause werden automatisch gespeichert.
          </div>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;color:var(--text-mid)">
            Standort
            <select id="ci-location" style="padding:10px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;background:var(--white);color:var(--aubergine)">
              ${locations.map(l => `<option value="${l.id}" ${l.id === defaultLocId ? 'selected' : ''}>${l.name}</option>`).join('')}
            </select>
          </label>
        </div>
        <div style="padding:0 20px 20px">
          <button id="ci-start" class="btn btn-accent" style="width:100%;justify-content:center">▶ Schicht starten</button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)
    overlay.querySelector('#ci-close').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
    overlay.querySelector('#ci-start').addEventListener('click', async () => {
      const locId = overlay.querySelector('#ci-location').value
      const btn   = overlay.querySelector('#ci-start')
      btn.disabled = true; btn.textContent = 'Starte...'
      await clockInShift(locId)
      overlay.remove()
    })
  }

  async function clockInShift(locationId) {
    clockInTime = new Date().toISOString()
    localStorage.setItem('clockIn_' + localDate(), clockInTime)
    await saveHours(8, 30, locationId)
    scheduleAutoCheckOut()
  }

  async function earlyCheckOut() {
    if (!clockInTime) return
    if (!confirm('Schicht jetzt beenden?\n\nDie tatsächliche Arbeitszeit wird berechnet und gespeichert.')) return
    if (autoCheckOutTimer) { clearTimeout(autoCheckOutTimer); autoCheckOutTimer = null }
    const diffH   = (Date.now() - new Date(clockInTime).getTime()) / 3600000
    const actualH = Math.max(0.5, Math.round(diffH * 4) / 4)
    localStorage.removeItem('clockIn_' + localDate())
    clockInTime = null
    await saveHours(actualH, 30)
  }

  function scheduleAutoCheckOut() {
    if (!clockInTime || !hoursToday || dateFrom !== localDate()) return
    if (autoCheckOutTimer) clearTimeout(autoCheckOutTimer)
    const plannedMs = Number(hoursToday.hours_worked) * 3600000
    const remaining = plannedMs - (Date.now() - new Date(clockInTime).getTime())
    if (remaining <= 0) { autoFinishShift(); return }
    autoCheckOutTimer = setTimeout(autoFinishShift, remaining)
  }

  function autoFinishShift() {
    autoCheckOutTimer = null
    localStorage.removeItem('clockIn_' + localDate())
    clockInTime = null
    rerender()
  }

  function buildMyHoursCard() {
    if (isManager) return ''

    let timeStr = '0 Std. 0 Min.'
    let subLine = ''

    if (hoursToday) {
      const h = Math.floor(hoursToday.hours_worked)
      const m = Math.round((hoursToday.hours_worked - h) * 60)
      timeStr = `${h} Std. ${m} Min.`
      const treatMins = todayLogs
        .filter(l => !l.is_cancelled && !l.is_no_show)
        .reduce((s, l) => s + Number(l.treatment?.duration ?? treatments.find(t => t.id === l.treatment_id)?.duration ?? 60), 0)
      const netMins = Math.max(1, hoursToday.hours_worked * 60 - hoursToday.break_minutes)
      const util    = Math.round((treatMins / netMins) * 100)
      const uCol    = util >= 80 ? '#27AE60' : util >= 50 ? 'var(--gold)' : 'var(--terracotta)'
      const netH    = Math.max(0, hoursToday.hours_worked - hoursToday.break_minutes / 60).toFixed(1)
      subLine = `<div style="font-size:0.78rem;color:var(--text-mid);margin-top:4px">Netto: <strong style="color:var(--aubergine)">${netH} Std.</strong> &nbsp;·&nbsp; Auslastung: <strong style="color:${uCol}">${util}%</strong></div>`
    }

    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;margin-bottom:16px;background:var(--cream);border-radius:var(--radius-md)">
        <div>
          <div style="font-size:0.65rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-light);margin-bottom:5px">Heute erfasst</div>
          <div style="font-size:1.55rem;font-weight:700;color:var(--aubergine);line-height:1.15">${timeStr}</div>
          ${subLine}
        </div>
        <button id="btn-log-hours" class="btn btn-ghost btn-sm" style="flex-shrink:0;padding:7px 13px;font-size:0.82rem">✏ Bearbeiten</button>
      </div>
    `
  }

  function buildHoursBanner() {
    const done   = !!hoursToday
    const active = !!clockInTime && dateFrom === localDate()

    if (!done) {
      return `
        <button id="btn-hours-banner" style="
          display:flex;align-items:center;justify-content:space-between;
          width:100%;padding:14px 18px;margin-bottom:20px;
          border:none;border-radius:var(--radius-md);cursor:pointer;
          background:var(--terracotta);color:#fff;
          box-shadow:0 2px 10px rgba(0,0,0,0.18);
        ">
          <span style="font-size:0.95rem;font-weight:700">▶ Schicht starten</span>
          <span style="font-size:0.8rem;opacity:0.85">Tippen zum Einloggen ›</span>
        </button>
      `
    }

    const netH = Math.max(0, Number(hoursToday.hours_worked) - Number(hoursToday.break_minutes) / 60).toFixed(1)

    if (active) {
      return `
        <button class="btn-early-checkout" style="
          display:flex;align-items:center;justify-content:center;gap:8px;
          width:100%;padding:14px 18px;margin-bottom:20px;
          border:none;border-radius:var(--radius-md);cursor:pointer;
          background:var(--gold);color:#fff;font-weight:700;font-size:0.95rem;
          box-shadow:0 2px 10px rgba(0,0,0,0.18);
        ">
          ➔ Schicht früher beenden
        </button>
      `
    }

    return `
      <div style="
        display:flex;align-items:center;justify-content:space-between;
        width:100%;padding:14px 18px;margin-bottom:20px;
        border-radius:var(--radius-md);
        background:#27AE60;color:#fff;
        box-shadow:0 2px 10px rgba(0,0,0,0.18);
      ">
        <span style="font-size:0.95rem;font-weight:700">✓ Arbeitszeit erfasst</span>
        <span style="font-size:0.8rem;opacity:0.85">${Number(hoursToday.hours_worked)} Std. · ${Number(hoursToday.break_minutes)} Min. Pause · ${netH} Std. Netto</span>
      </div>
    `
  }

  // ── Modal ─────────────────────────────────────────────────────────────────────

  const PAYMENT_METHODS = [
    { value: 'bar',       label: 'Bar'          },
    { value: 'ec',        label: 'EC-Karte'     },
    { value: 'paypal',    label: 'PayPal'        },
    { value: 'online',    label: 'Online vorab' },
    { value: 'gutschein', label: 'Gutschein'    },
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
    const curPay   = existingLog?.payment_method ?? ''
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
        <div style="margin:12px 20px 0;display:flex;align-items:center;background:var(--cream-dark);border-radius:var(--radius-sm);padding:10px 14px">
          <select id="modal-treatment"
            style="flex:1;background:transparent;border:none;outline:none;font-size:0.92rem;color:var(--aubergine);font-weight:600;cursor:pointer">
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
          ${isEdit ? `<button id="modal-delete" class="btn" style="background:var(--terracotta);color:#fff;flex:0 0 auto">Stornieren</button>` : ''}
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
    const splitSection = overlay.querySelector('#split-section')
    const splitToggle  = overlay.querySelector('#btn-split-toggle')
    const splitAmt1    = overlay.querySelector('#split-amt-1')
    const splitAmt2    = overlay.querySelector('#split-amt-2')
    const splitMethod2 = overlay.querySelector('#split-method-2')
    let splitActive    = !!existingLog?.payment_method_2

    // Treatment switcher (edit + manager only): sync price badge + revenue preview
    treatSelect?.addEventListener('change', () => {
      activeTreatment = availableTreats.find(t => t.id === treatSelect.value) ?? activeTreatment
      priceVal.textContent = fmt(activeTreatment.price ?? 0)
      updatePreview()
    })

    // Payment button toggle
    let selectedPayment = curPay
    const saveBtn = overlay.querySelector('#modal-save')

    function syncSaveBtn() {
      const valid = !!selectedPayment
      saveBtn.style.opacity       = valid ? '1' : '0.45'
      saveBtn.style.cursor        = valid ? '' : 'not-allowed'
      saveBtn.style.pointerEvents = valid ? '' : 'none'
    }
    if (!existingLog) syncSaveBtn()  // new entries start locked

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

    // Split payment logic
    function getTotalForSplit() {
      const ns = nsCheckbox.checked
      if (ns) return 0
      const u = Math.max(0, parseFloat(upsellInput.value) || 0)
      return (activeTreatment.price ?? 0) + u
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

    // Pre-fill split section when editing a split payment
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
      const ns    = nsCheckbox.checked
      const u     = ns ? 0 : Math.max(0, parseFloat(upsellInput.value) || 0)
      const t     = ns ? 0 : Math.max(0, parseFloat(tipInput.value) || 0)
      const empId = overlay.querySelector('#modal-employee')?.value ?? user.id

      if (u < 0 || t < 0) { showToast('Keine negativen Beträge.', 'error'); return }

      // Split validation
      const totalRev = ns ? 0 : (activeTreatment.price ?? 0) + u
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
        treatment_id:     activeTreatment.id,
        upsell_amount:    u,
        tip:              t,
        is_no_show:       ns,
        payment_method:   selectedPayment,
        employee_id:      empId,
        payment_method_2: splitM2,
        amount_method_1:  splitA1,
        amount_method_2:  splitA2,
      }, existingLog?.id)

      if (ok) overlay.remove()
      else { saveBtnEl.disabled = false; saveBtnEl.textContent = 'Speichern' }
    })

    overlay.querySelector('#modal-delete')?.addEventListener('click', () => {
      overlay.remove()
      cancelLog(existingLog.id)
    })
  }

  // ── Cockpit helpers ───────────────────────────────────────────────────────────

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
      const initBreak = Number(dbH?.break_minutes ?? 0)
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
          <div class="stat-sub">ohne No-Shows & Stornos</div>
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
        ` : treatsHere.length ? `
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
        <div class="card-header"><h4>${isManager ? (period === 'week' ? 'Einträge diese Woche' : period === 'month' ? 'Einträge diesen Monat' : 'Heutige Einträge') : 'Einträge am Tag'}</h4><span style="font-size:0.78rem;color:var(--text-light)">${todayLogs.length} Einträge</span></div>
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
                  const cancelled = log.is_cancelled === true
                  const rowOpacity = cancelled ? 'opacity:0.6' : log.is_no_show ? 'opacity:0.5' : ''
                  const strikeStyle = cancelled ? 'text-decoration:line-through;color:var(--text-light)' : ''
                  return `
                  <tr style="${rowOpacity}">
                    <td style="padding:5px 10px;white-space:nowrap;${strikeStyle || 'color:var(--text-mid)'}">${new Date(log.created_at).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' })}</td>
                    ${isManager ? `<td style="padding:5px 10px;font-size:0.78rem;${strikeStyle || 'color:var(--text-mid)'}">${log.employee?.full_name ?? '–'}</td>` : ''}
                    <td style="padding:5px 10px;${strikeStyle}">
                      ${log.treatment?.name ?? '–'}
                      ${log.is_no_show && !cancelled ? `<span style="font-size:0.65rem;background:var(--terracotta);color:#fff;border-radius:4px;padding:1px 4px;margin-left:3px">NS</span>` : ''}
                      ${cancelled ? `<span style="font-size:0.65rem;background:var(--terracotta);color:#fff;border-radius:4px;padding:1px 5px;margin-left:4px;font-style:normal;font-weight:600">Storniert</span>${isManager && log.cancelled_by ? `<span style="font-size:0.65rem;color:var(--text-light);margin-left:4px">(von: ${cancellerName(log.cancelled_by) ?? '–'})</span>` : ''}` : ''}
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

  function buildHoursHistory() {
    if (isManager || !hoursToday) return ''

    const h    = Math.floor(hoursToday.hours_worked)
    const m    = Math.round((hoursToday.hours_worked - h) * 60)
    const netH = Math.max(0, hoursToday.hours_worked - hoursToday.break_minutes / 60).toFixed(1)

    let startStr = '–', endStr = '–'
    if (hoursToday.clock_in_time) {
      const cin = new Date(hoursToday.clock_in_time)
      startStr = cin.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr'
      const cout = new Date(cin.getTime() + hoursToday.hours_worked * 3600000)
      endStr = cout.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr'
    }

    let modHtml = ''
    if (hoursToday.is_modified && hoursToday.original_hours_worked != null) {
      const oh  = Math.floor(hoursToday.original_hours_worked)
      const om  = Math.round((hoursToday.original_hours_worked - oh) * 60)
      const modDate = hoursToday.modified_at
        ? new Date(hoursToday.modified_at).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })
        : '–'
      modHtml = `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;background:rgba(181,87,58,0.06);border-radius:var(--radius-sm);font-size:0.82rem;margin-top:6px">
          <span style="color:var(--terracotta);opacity:0.75;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em">Geändert ${modDate}</span>
          <span style="text-decoration:line-through;color:var(--terracotta)">${oh} Std. ${om} Min.</span>
          <span style="color:var(--text-light)">→</span>
          <span style="color:#27AE60;font-weight:600">${h} Std. ${m} Min.</span>
        </div>
      `
    }

    return `
      <div class="card" style="margin-top:24px">
        <div class="card-header">
          <h4>📋 Arbeitszeiten-Historie</h4>
          <span style="font-size:0.78rem;color:var(--text-light)">${new Date(dateFrom + 'T12:00:00').toLocaleDateString('de-DE', { weekday:'short', day:'numeric', month:'short' })}</span>
        </div>
        <div style="padding:12px 16px">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
            <div style="font-size:0.9rem;color:var(--aubergine)">
              <strong>${startStr}</strong>
              <span style="color:var(--text-light);margin:0 6px">→</span>
              <strong>${endStr}</strong>
            </div>
            <div style="font-size:0.82rem;color:var(--text-mid)">
              ${h} Std. ${m} Min. &nbsp;·&nbsp; ${hoursToday.break_minutes} Min. Pause &nbsp;·&nbsp; Netto: <strong style="color:var(--aubergine)">${netH} Std.</strong>
            </div>
          </div>
          ${modHtml}
        </div>
      </div>
    `
  }

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
      selectedLocationId = e.target.value || 'all'  // never null — 'all' = no filter
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

    container.querySelectorAll('.btn-treatment[data-id]').forEach(btn => {
      btn.addEventListener('pointerenter', () => { btn.style.borderColor = 'var(--aubergine)'; btn.style.background = 'var(--cream)' })
      btn.addEventListener('pointerleave', () => { btn.style.borderColor = 'var(--cream-dark)'; btn.style.background = 'var(--white)' })
      btn.addEventListener('click', () => {
        const t = treatments.find(t => t.id === btn.dataset.id)
        if (t) openModal(t)
      })
    })

    container.querySelector('#goto-admin')?.addEventListener('click', () => onNavigate?.('admin'))
    container.querySelector('#btn-log-hours')?.addEventListener('click', () => openHoursModal())
    container.querySelector('#btn-hours-banner')?.addEventListener('click', () => openClockInModal())
    container.querySelectorAll('.btn-early-checkout').forEach(btn => {
      btn.addEventListener('click', () => earlyCheckOut())
    })

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

    // Live utilization recalculation — net formula: (treat_mins / (hours*60 - break_mins)) * 100
    function recalcUtil(empId) {
      const hoursInput = container.querySelector(`.hours-input[data-emp="${empId}"]`)
      const breakInput = container.querySelector(`.break-input[data-emp="${empId}"]`)
      const display    = container.querySelector(`.util-display[data-emp="${empId}"]`)
      if (!hoursInput || !display) return
      const minutes  = Number(hoursInput.dataset.minutes)
      const hours    = Math.max(0.5, parseFloat(hoursInput.value) || 8)
      const breakMins = Math.max(0, parseFloat(breakInput?.value) || 0)
      const netMins  = Math.max(1, hours * 60 - breakMins)
      const util     = Math.round((minutes / netMins) * 100)
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
    if (!isManager) scheduleAutoCheckOut()
    return el
  }

  return { render }
}

function fmt(n) {
  return Number(n ?? 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
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
