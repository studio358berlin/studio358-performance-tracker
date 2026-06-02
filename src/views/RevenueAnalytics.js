import { supabase } from '../lib/supabase.js'

// ── Revenue Analytics – Manager-only ─────────────────────────────────────────

export function RevenueAnalytics({ user }) {
  const STUDIO_SLUG   = { 'KaDeWe': 'kadewe', 'Studio Mitte': 'mitte' }
  const mgrStudios    = user?.profile?.role === 'manager' ? (user?.profile?.assigned_studios ?? []) : null
  const forcedLocSlug = mgrStudios?.length === 1 ? (STUDIO_SLUG[mgrStudios[0]] ?? null) : null

  function isEmpVisible(prof) {
    if (!mgrStudios)        return true
    if (!mgrStudios.length) return true
    return mgrStudios.some(s => (prof.assigned_studios ?? []).includes(s))
  }

  let locations   = []
  let logs        = []
  let profiles    = []
  let treatments  = []
  let dailyTarget = 0

  let selectedLocationId = localStorage.getItem('selectedLocationId') || user?.profile?.location_id || null
  let selectedEmployeeId = null
  let period        = localStorage.getItem('analyticsPeriod') || 'today'
  let dateFrom      = localStorage.getItem('analyticsFrom')   || localDate()
  let dateTo        = localStorage.getItem('analyticsTo')     || localDate()
  let container     = null

  let topServicesData = []   // rows from get_top_services_analysis RPC
  let hoursData       = []   // rows from employee_daily_hours

  // ── Date helpers ──────────────────────────────────────────────────────────

  function dateRange() {
    const from    = new Date(dateFrom + 'T00:00:00').toISOString()
    const to      = new Date(dateTo   + 'T23:59:59').toISOString()
    const fmtDate = d => d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })
    const label   = dateFrom === dateTo
      ? (dateFrom === localDate() ? 'Heute' : fmtDate(new Date(dateFrom + 'T12:00:00')))
      : fmtDate(new Date(dateFrom + 'T12:00:00')) + ' – ' + fmtDate(new Date(dateTo + 'T12:00:00'))
    return { from, to, label }
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  async function loadData() {
    const [locRes, profRes, treatRes] = await Promise.all([
      supabase.from('locations').select('*').order('name'),
      supabase.from('profiles').select('id, full_name, location_id, assigned_studios').eq('is_manager', false),
      supabase.from('treatments').select('id, name, duration, price, location_id').order('name'),
    ])
    locations  = locRes.data  ?? []
    profiles   = profRes.data ?? []
    treatments = treatRes.data ?? []

    // Manager studio filter: restrict visible profiles via assigned_studios
    if (mgrStudios?.length) {
      profiles = profiles.filter(isEmpVisible)
      if (forcedLocSlug) {
        const studioLoc = locations.find(l => l.slug === forcedLocSlug)
        if (studioLoc) selectedLocationId = studioLoc.id
      }
    }
    if (!selectedLocationId) selectedLocationId = 'all'
    await Promise.all([loadLogs(), loadTarget(), loadHours(), loadTopServices()])
  }

  async function loadLogs() {
    const { from, to } = dateRange()
    let q = supabase
      .from('daily_revenue_logs')
      .select('*')
      .eq('is_cancelled', false)
      .gte('created_at', from)
      .lte('created_at', to)

    if (selectedLocationId && selectedLocationId !== 'all') {
      q = q.eq('location_id', selectedLocationId)
    }

    const { data } = await q
    logs = data ?? []
  }

  async function loadTopServices() {
    const d = new Date(dateFrom + 'T12:00:00')
    const { data, error } = await supabase.rpc('get_top_services_analysis', {
      target_year:  d.getFullYear(),
      target_month: d.getMonth() + 1,
    })
    if (error) console.error('[RevenueAnalytics] get_top_services_analysis:', error.message)
    topServicesData = data ?? []
  }

  async function loadTarget() {
    if (!selectedLocationId || selectedLocationId === 'all') { dailyTarget = 0; return }

    // Check for a date-override first (uses selectedDate, not system clock)
    const today = dateFrom
    const { data: override } = await supabase
      .from('daily_targets')
      .select('target_override')
      .eq('location_id', selectedLocationId)
      .eq('date', today)
      .maybeSingle()

    if (override?.target_override != null) {
      dailyTarget = Number(override.target_override)
      return
    }
    const loc = locations.find(l => l.id === selectedLocationId)
    dailyTarget = Number(loc?.daily_revenue_target ?? 0)
  }

  async function loadHours() {
    let q = supabase
      .from('employee_daily_hours')
      .select('employee_id, date, hours_worked, break_minutes, location_id')
      .gte('date', dateFrom)
      .lte('date', dateTo)

    if (selectedLocationId && selectedLocationId !== 'all') {
      q = q.eq('location_id', selectedLocationId)
    }

    const { data } = await q
    hoursData = data ?? []
  }

  // ── KPI calculations ──────────────────────────────────────────────────────

  function filteredLogs() {
    const active = logs.filter(l => !l.is_cancelled)
    if (!selectedEmployeeId) return active
    return active.filter(l => l.employee_id === selectedEmployeeId)
  }

  function kpis() {
    const source  = filteredLogs()
    const real    = source.filter(l => !l.is_no_show)
    const noShows = source.filter(l =>  l.is_no_show)

    const totalRevenue = real.reduce((s, l) => s + Number(l.revenue),       0)
    const totalTips    = source.reduce((s, l) => s + Number(l.tip),         0)
    const avgPerClient = real.length ? totalRevenue / real.length : 0
    const noShowRate   = source.length ? (noShows.length / source.length) * 100 : 0

    // Only "today" shows the gauge target percentage
    const todayRevenue  = period === 'today' ? totalRevenue : null
    const targetPct     = (dailyTarget > 0 && todayRevenue !== null) ? (todayRevenue / dailyTarget) * 100 : 0

    // Per-employee aggregates
    const byEmployee = {}
    real.forEach(l => {
      if (!byEmployee[l.employee_id]) byEmployee[l.employee_id] = { revenue: 0, tips: 0 }
      byEmployee[l.employee_id].revenue += Number(l.revenue)
      byEmployee[l.employee_id].tips    += Number(l.tip)
    })

    // Per-treatment count
    const byTreatment = {}
    real.forEach(l => {
      if (!l.treatment_id) return
      byTreatment[l.treatment_id] = (byTreatment[l.treatment_id] ?? 0) + 1
    })

    return { totalRevenue, totalTips, avgPerClient, noShowRate, noShows: noShows.length,
             total: logs.length, targetPct, byEmployee, byTreatment }
  }

  function empName(id) {
    return profiles.find(p => p.id === id)?.full_name ?? 'Unbekannt'
  }
  function treatName(id) {
    return treatments.find(t => t.id === id)?.name ?? 'Unbekannt'
  }

  // ── SVG Gauge (Umsatz-Uhr) ────────────────────────────────────────────────

  function buildGauge(pct) {
    // Semicircle gauge, 180° sweep (left to right)
    // We cap visual at 150% but show real number
    const display = Math.min(pct, 150)
    const angle   = (display / 150) * 180  // degrees, 0=left 180=right

    // SVG arc helper
    function polarToXY(deg, r) {
      const rad = ((deg - 180) * Math.PI) / 180
      return { x: 100 + r * Math.cos(rad), y: 110 + r * Math.sin(rad) }
    }

    function arc(startDeg, endDeg, r, color) {
      if (endDeg <= startDeg) return ''
      const s = polarToXY(startDeg, r)
      const e = polarToXY(endDeg, r)
      const large = endDeg - startDeg > 180 ? 1 : 0
      return `<path d="M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}" fill="none" stroke="${color}" stroke-width="16" stroke-linecap="round"/>`
    }

    // Color zones (mapped to degrees)
    const zones = [
      { from: 0,   to: 40,  color: '#B5573A' }, // red   0–40%
      { from: 40,  to: 80,  color: '#D4935A' }, // amber 40–80%
      { from: 80,  to: 100, color: '#6B8F71' }, // green 80–100%
      { from: 100, to: 150, color: '#5A8FD4' }, // blue  >100%
    ]

    const bgArcs = zones.map(z =>
      arc(z.from / 150 * 180, z.to / 150 * 180, 72, color(z.color, 0.18))
    ).join('')

    const fgArcs = zones.map(z => {
      const start = z.from / 150 * 180
      const end   = Math.min(angle, z.to / 150 * 180)
      if (end <= start) return ''
      return arc(start, end, 72, z.color)
    }).join('')

    // Needle tip
    const tip  = polarToXY(angle, 68)
    const base = polarToXY(angle - 90, 8)
    const base2 = polarToXY(angle + 90, 8)

    const gaugeColor = pct < 40 ? '#B5573A' : pct < 80 ? '#D4935A' : pct < 100 ? '#6B8F71' : '#5A8FD4'

    return `
      <div style="display:flex;flex-direction:column;align-items:center;padding:16px 0 8px">
        <svg viewBox="0 0 200 120" style="width:100%;max-width:280px" aria-label="Umsatz-Uhr">
          <!-- Background track -->
          ${bgArcs}
          <!-- Value arcs -->
          ${fgArcs}
          <!-- Needle -->
          <circle cx="100" cy="110" r="8" fill="var(--aubergine)"/>
          <line x1="100" y1="110" x2="${tip.x}" y2="${tip.y}"
            stroke="var(--aubergine)" stroke-width="3" stroke-linecap="round"/>
          <!-- Center label -->
          <text x="100" y="98" text-anchor="middle" font-size="20" font-weight="700"
            fill="${gaugeColor}" font-family="system-ui">${Math.round(pct)}%</text>
          <text x="100" y="112" text-anchor="middle" font-size="7" fill="rgba(61,43,53,0.5)"
            font-family="system-ui">von Tagesziel</text>
        </svg>
        <div style="font-size:0.75rem;color:var(--text-light);margin-top:4px">
          Tagesziel: <strong style="color:var(--text-dark)">${fmt(dailyTarget)}</strong>
        </div>
      </div>
    `
  }

  // ── Top-Performer cards ───────────────────────────────────────────────────

  function buildTopPerformer(byEmployee) {
    const entries = Object.entries(byEmployee)
    const byRev = [...entries].sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 3)
    const byTip = [...entries].sort((a, b) => b[1].tips    - a[1].tips   ).slice(0, 3)

    function rankList(list, key, label) {
      if (!list.length) return `<p style="color:var(--text-light);font-size:0.82rem">Keine Daten</p>`
      const medals = ['🥇','🥈','🥉']
      return list.map(([id, val], i) => `
        <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--cream-dark);${i === list.length-1 ? 'border:none' : ''}">
          <span style="font-size:1rem;width:24px;text-align:center">${medals[i]}</span>
          <span style="flex:1;font-size:0.875rem;font-weight:500;color:var(--text-dark)">${empName(id)}</span>
          <strong style="color:var(--aubergine);font-size:0.875rem">${fmt(val[key])}</strong>
        </div>
      `).join('')
    }

    return `
      <div class="top-performer-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
        <div class="card">
          <div class="card-header" style="padding-bottom:8px"><h4>Umsatzkönig</h4></div>
          <div style="padding:0 20px 16px">${rankList(byRev, 'revenue', 'Umsatz')}</div>
        </div>
        <div class="card">
          <div class="card-header" style="padding-bottom:8px"><h4>Service-König</h4><span style="font-size:0.72rem;color:var(--text-light)">Trinkgeld</span></div>
          <div style="padding:0 20px 16px">${rankList(byTip, 'tips', 'Trinkgeld')}</div>
        </div>
      </div>
    `
  }

  // ── Top Services bar chart (RPC: get_top_services_analysis) ─────────────

  function buildTopServicesChart() {
    if (!topServicesData.length) {
      return `<div class="empty-state"><span class="empty-state-icon">◉</span><p>Keine Behandlungsdaten für diesen Monat.</p></div>`
    }
    const max = Math.max(...topServicesData.map(r => Number(r.count ?? r.total_count ?? 0)), 1)
    return topServicesData.map(row => {
      const count   = Number(row.count ?? row.total_count ?? 0)
      const pct     = (count / max) * 100
      const name    = row.treatment_name ?? row.name ?? '–'
      const revenue = fmt(row.total_revenue ?? 0)
      return `
        <div style="display:grid;grid-template-columns:140px 1fr auto;align-items:center;gap:10px;margin-bottom:10px">
          <span style="font-size:0.82rem;color:var(--text-mid);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${name}">${name}</span>
          <div style="background:var(--cream-dark);border-radius:4px;height:10px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:var(--aubergine);border-radius:4px;transition:width 0.4s ease"></div>
          </div>
          <span style="font-size:0.82rem;font-weight:600;color:var(--aubergine);text-align:right;white-space:nowrap">${count}× · ${revenue}</span>
        </div>
      `
    }).join('')
  }

  // ── Trinkgeld-Zusammenfassung ─────────────────────────────────────────────

  function buildTipSummary() {
    const source = filteredLogs()
    // Aggregate tips per employee (all entries, including no-shows tips = 0)
    const byEmp = {}
    source.forEach(l => {
      if (!byEmp[l.employee_id]) byEmp[l.employee_id] = { tip: 0, location_id: l.location_id }
      byEmp[l.employee_id].tip += Number(l.tip)
    })

    const rows = Object.entries(byEmp)
      .filter(([, v]) => v.tip > 0)
      .sort((a, b) => b[1].tip - a[1].tip)

    if (!rows.length) return `<div class="empty-state"><span class="empty-state-icon">◉</span><p>Kein Trinkgeld in diesem Zeitraum.</p></div>`

    return `
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Mitarbeiter</th>
              <th>Standort</th>
              <th style="text-align:right">Trinkgeld</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(([id, v]) => `
              <tr>
                <td style="font-weight:500">${empName(id)}</td>
                <td><span class="badge badge-neutral">${locName(v.location_id)}</span></td>
                <td style="text-align:right;font-weight:600;color:var(--gold)">${fmt(v.tip)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `
  }

  function locName(id) {
    return locations.find(l => l.id === id)?.name ?? '–'
  }

  // ── Mitarbeiter-Umsatz (live, aus dateFrom/dateTo) ───────────────────────

  function buildEmployeeRevenueTable() {
    const { label } = dateRange()
    const source = filteredLogs().filter(l => !l.is_no_show)
    const byEmp  = {}
    source.forEach(l => {
      if (!byEmp[l.employee_id]) byEmp[l.employee_id] = { revenue: 0, tips: 0, count: 0 }
      byEmp[l.employee_id].revenue += Number(l.revenue)
      byEmp[l.employee_id].tips    += Number(l.tip)
      byEmp[l.employee_id].count++
    })
    const rows = Object.entries(byEmp).sort((a, b) => b[1].revenue - a[1].revenue)

    return `
      <div class="card" style="margin-bottom:24px">
        <div class="card-header">
          <h4>Mitarbeiter-Umsatz</h4>
          <span style="font-size:0.75rem;color:var(--text-light)">${label}</span>
        </div>
        ${!rows.length ? `
          <div class="empty-state" style="padding:32px 20px">
            <span class="empty-state-icon">◉</span>
            <p>Keine Umsatzdaten im gewählten Zeitraum.</p>
          </div>
        ` : `
          <div class="table-wrapper">
            <table style="font-size:0.85rem">
              <thead>
                <tr>
                  <th>Mitarbeiter</th>
                  <th style="text-align:center">Behandlungen</th>
                  <th style="text-align:right">Umsatz</th>
                  <th style="text-align:right">Ø pro Kunde</th>
                  <th style="text-align:right">Trinkgeld</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(([id, v]) => {
                  const avg = v.count > 0 ? v.revenue / v.count : 0
                  return `
                    <tr>
                      <td style="font-weight:600;color:var(--aubergine)">${empName(id)}</td>
                      <td style="text-align:center">${v.count}</td>
                      <td style="text-align:right;font-weight:600;color:var(--aubergine)">${fmt(v.revenue)}</td>
                      <td style="text-align:right;color:var(--text-mid)">${fmt(avg)}</td>
                      <td style="text-align:right;color:var(--gold)">${v.tips > 0 ? fmt(v.tips) : '–'}</td>
                    </tr>
                  `
                }).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `
  }

  // ── Controlling Master Export (4 Blocks) ─────────────────────────────────

  async function downloadControllingCsv(btn) {
    const { from, to, label } = dateRange()
    const origText = btn.textContent
    btn.disabled = true
    btn.textContent = 'Lade Daten…'

    let q = supabase
      .from('daily_revenue_logs')
      .select('*')
      .gte('created_at', from)
      .lte('created_at', to)
      .order('created_at', { ascending: true })

    if (selectedLocationId && selectedLocationId !== 'all') {
      q = q.eq('location_id', selectedLocationId)
    }

    const { data: allData } = await q
    btn.disabled = false
    btn.textContent = origText

    const all       = allData ?? []
    const active    = all.filter(l => !l.is_cancelled && !l.is_no_show)
    const cancelled = all.filter(l =>  l.is_cancelled)

    const PAYMENT_KEYS   = ['bar', 'ec', 'paypal', 'online', 'gutschein']
    const PAYMENT_LABELS = { bar: 'Bar', ec: 'EC-Karte', paypal: 'PayPal', online: 'Online vorab', gutschein: 'Gutschein' }

    const fmtCur = n => Number(n ?? 0).toFixed(2).replace('.', ',')
    const q_     = s => `"${String(s ?? '').replace(/"/g, '""')}"`

    const lines = []

    // ── BLOCK 1: KASSEN- & TRINKGELD-AUDIT ─────────────────────────────────
    lines.push('BLOCK 1 – KASSEN- & TRINKGELD-AUDIT')
    lines.push('Zahlungsart;Umsatz (€);Trinkgeld (€)')

    const byPay    = {}
    const tipByPay = {}
    PAYMENT_KEYS.forEach(k => { byPay[k] = 0; tipByPay[k] = 0 })

    active.forEach(l => {
      const pm = l.payment_method ?? 'bar'
      if (l.payment_method_2) {
        byPay[pm]                 = (byPay[pm]                 ?? 0) + Number(l.amount_method_1 ?? 0)
        byPay[l.payment_method_2] = (byPay[l.payment_method_2] ?? 0) + Number(l.amount_method_2 ?? 0)
      } else {
        byPay[pm] = (byPay[pm] ?? 0) + Number(l.revenue ?? 0)
      }
      tipByPay[pm] = (tipByPay[pm] ?? 0) + Number(l.tip ?? 0)
    })

    PAYMENT_KEYS.forEach(k => {
      lines.push(`${PAYMENT_LABELS[k]};${fmtCur(byPay[k])};${fmtCur(tipByPay[k])}`)
    })

    const totalRev  = active.reduce((s, l) => s + Number(l.revenue ?? 0), 0)
    const totalTip  = active.reduce((s, l) => s + Number(l.tip    ?? 0), 0)
    const cancelVol = cancelled.reduce((s, l) => s + Number(l.revenue ?? 0), 0)

    lines.push('')
    lines.push(`GESAMTSUMME UMSATZ;${fmtCur(totalRev)};`)
    lines.push(`GESAMTSUMME TRINKGELD;;${fmtCur(totalTip)}`)
    lines.push(`Anzahl Stornos;${cancelled.length};`)
    lines.push(`Storniertes Volumen;${fmtCur(cancelVol)};`)
    lines.push('')
    lines.push('')

    // ── BLOCK 2: SERVICE-PERFORMANCE MATRIX ────────────────────────────────
    lines.push('BLOCK 2 – SERVICE-PERFORMANCE MATRIX')
    lines.push('Behandlung;Anzahl Behandlungen;Gesamtumsatz (€);Ø-Umsatz pro Behandlung (€)')

    const bySvc = {}
    active.forEach(l => {
      const name = treatName(l.treatment_id)
      if (!bySvc[name]) bySvc[name] = { count: 0, revenue: 0 }
      bySvc[name].count++
      bySvc[name].revenue += Number(l.revenue ?? 0)
    })

    Object.entries(bySvc)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .forEach(([name, v]) => {
        const avg = v.count > 0 ? v.revenue / v.count : 0
        lines.push(`${q_(name)};${q_(v.count)};${q_(fmtCur(v.revenue))};${q_(fmtCur(avg))}`)
      })

    lines.push('')
    lines.push('')

    // ── BLOCK 3: MITARBEITER-ERFOLGSMATRIX ─────────────────────────────────
    lines.push('BLOCK 3 – MITARBEITER-ERFOLGSMATRIX')
    lines.push('Mitarbeiter;Anzahl Behandlungen;Gesamtumsatz (€);Ø-Umsatz pro Kunde (€);Trinkgeld Gesamt (€)')

    const byEmpMap = {}
    active.forEach(l => {
      const name = empName(l.employee_id)
      if (!byEmpMap[name]) byEmpMap[name] = { count: 0, revenue: 0, tips: 0 }
      byEmpMap[name].count++
      byEmpMap[name].revenue += Number(l.revenue ?? 0)
      byEmpMap[name].tips    += Number(l.tip    ?? 0)
    })

    Object.entries(byEmpMap)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .forEach(([name, v]) => {
        const avg = v.count > 0 ? v.revenue / v.count : 0
        lines.push(`${q_(name)};${q_(v.count)};${q_(fmtCur(v.revenue))};${q_(fmtCur(avg))};${q_(fmtCur(v.tips))}`)
      })

    lines.push('')
    lines.push('')

    // ── BLOCK 4: RECHTLICHE BUCHUNGSLISTE (ROHDATEN) ────────────────────────
    lines.push('BLOCK 4 – RECHTLICHE BUCHUNGSLISTE (ROHDATEN)')
    lines.push('Datum & Uhrzeit;Studio/Standort;Mitarbeiter;Behandlung;Gesamtpreis (€);Zahlungsart 1;Betrag 1 (€);Zahlungsart 2;Betrag 2 (€);Trinkgeld (€);Status')

    all.forEach(l => {
      const d   = new Date(l.created_at)
      const pad = n => String(n).padStart(2, '0')
      const dt  = `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
      const loc    = locName(l.location_id)
      const emp    = empName(l.employee_id)
      const treat  = treatName(l.treatment_id)
      const price  = fmtCur(l.revenue ?? 0)
      const pm1    = PAYMENT_LABELS[l.payment_method ?? 'bar'] ?? (l.payment_method ?? '–')
      const amt1   = l.payment_method_2 ? fmtCur(l.amount_method_1 ?? 0) : price
      const pm2    = l.payment_method_2 ? (PAYMENT_LABELS[l.payment_method_2] ?? l.payment_method_2) : ''
      const amt2   = l.payment_method_2 ? fmtCur(l.amount_method_2 ?? 0) : ''
      const tip    = fmtCur(l.tip ?? 0)
      const status = l.is_cancelled ? 'STORNIERT' : l.is_no_show ? 'No-Show' : 'Aktiv'

      lines.push(`${q_(dt)};${q_(loc)};${q_(emp)};${q_(treat)};${q_(price)};${q_(pm1)};${q_(amt1)};${q_(pm2)};${q_(amt2)};${q_(tip)};${q_(status)}`)
    })

    // ── Download ────────────────────────────────────────────────────────────
    const csv  = '﻿' + lines.join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `controlling_${label.replace(/[^\wäöüÄÖÜ-]/g, '_')}_${localDate()}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // ── Main HTML ─────────────────────────────────────────────────────────────

  function buildUtilizationTile() {
    const totalNetMins = hoursData.reduce((s, h) => {
      return s + Math.max(0, Number(h.hours_worked ?? 0) * 60 - Number(h.break_minutes ?? 0))
    }, 0)
    const activeLogs = filteredLogs().filter(l => !l.is_no_show)
    const treatMins  = activeLogs.reduce((s, l) => {
      const dur = Number(treatments.find(t => t.id === l.treatment_id)?.duration ?? 45)
      return s + (dur > 0 ? dur : 45)
    }, 0)
    const utilPct = totalNetMins > 0 ? Math.min(Math.round((treatMins / totalNetMins) * 100), 999) : 0
    const uColor  = utilPct >= 80 ? '#27AE60' : utilPct >= 50 ? 'var(--gold)' : 'var(--terracotta)'
    return `
      <div class="stat-card">
        <div class="stat-label">Auslastungs-Spion</div>
        <div class="stat-value" style="color:${uColor}">${utilPct}%</div>
        <div class="stat-sub">aktive Behandlungszeit / Präsenzzeit</div>
        ${totalNetMins > 0
          ? `<div style="font-size:0.68rem;color:var(--text-light);margin-top:4px">${(treatMins/60).toFixed(1)} Std. aktiv · ${(totalNetMins/60).toFixed(1)} Std. Präsenz</div>`
          : '<div style="font-size:0.68rem;color:var(--text-light);margin-top:4px">Keine Zeiterfassung im Zeitraum</div>'}
      </div>
    `
  }

  function periodSubtitle() {
    if (period === 'today') return 'Manager Übersicht · Heute'
    if (period === 'week')  return 'Manager Übersicht · Diese Woche'
    if (period === 'month') return 'Manager Übersicht · Dieser Monat'
    return 'Manager Übersicht · Benutzerdefinierter Zeitraum'
  }

  function buildHTML() {
    const k = kpis()
    const { from, label } = dateRange()

    return `
      <div class="page-header">
        <div>
          <h2>Umsatz Cockpit</h2>
          <p style="color:var(--text-light);font-size:0.875rem">${periodSubtitle()}</p>
        </div>
        <button class="btn btn-sm btn-accent" id="export-csv-btn">↓ Umsatz Export (.CSV)</button>
        <button class="btn btn-sm" id="backfill-btn" style="background:var(--white);color:var(--aubergine);border:2px solid var(--aubergine)">[ Behandlung nachtragen ]</button>
      </div>

      <!-- Filter bar: Row 1 = Tabs + Von/Bis, Row 2 = Standort + Mitarbeiter -->
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:24px">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px">
          <div class="location-tabs" style="margin:0">
            <button class="location-tab ${period==='today' ? 'active':''}" data-period="today">Heute</button>
            <button class="location-tab ${period==='week'  ? 'active':''}" data-period="week">Woche</button>
            <button class="location-tab ${period==='month' ? 'active':''}" data-period="month">Monat</button>
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
          <select id="analytics-location" style="padding:7px 12px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);background:var(--white);font-size:0.875rem" ${forcedLocSlug ? 'disabled' : ''}>
            <option value="all" ${selectedLocationId === 'all' ? 'selected' : ''}>Alle Standorte</option>
            ${locations.map(l => `<option value="${l.id}" ${l.id===selectedLocationId?'selected':''}>${l.name}</option>`).join('')}
          </select>
          <select id="analytics-employee" style="padding:7px 12px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);background:var(--white);font-size:0.875rem">
            <option value="">Alle Mitarbeiter</option>
            ${profiles.map(p => `<option value="${p.id}" ${p.id===selectedEmployeeId?'selected':''}>${p.full_name}</option>`).join('')}
          </select>
        </div>
      </div>

      <!-- Gauge + KPI tiles -->
      <div class="analytics-layout" style="display:grid;grid-template-columns:240px 1fr;gap:16px;margin-bottom:24px;align-items:start">
        <!-- Gauge: only meaningful for "today" -->
        <div class="card" style="padding:8px">
          <div style="text-align:center;font-size:0.72rem;font-weight:600;color:var(--text-light);letter-spacing:0.08em;text-transform:uppercase;padding-top:12px">Umsatz-Uhr</div>
          ${dateFrom === dateTo && dateFrom === localDate()
            ? buildGauge(k.targetPct)
            : `<div style="padding:24px;text-align:center;color:var(--text-light);font-size:0.82rem">Nur für Tagesansicht verfügbar.</div>`
          }
        </div>

        <!-- KPI tiles -->
        <div class="stat-grid" style="align-content:start">
          <div class="stat-card">
            <div class="stat-label">Gesamtumsatz</div>
            <div class="stat-value" style="color:var(--aubergine)">${fmt(k.totalRevenue)}</div>
            <div class="stat-sub">${label} · ohne No-Shows</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Ø pro Kunde</div>
            <div class="stat-value">${fmt(k.avgPerClient)}</div>
            <div class="stat-sub">${k.total} Termine gesamt</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">No-Show Rate</div>
            <div class="stat-value" style="color:${k.noShowRate > 15 ? 'var(--terracotta)' : 'var(--aubergine)'}">
              ${k.noShowRate.toFixed(1)}%
            </div>
            <div class="stat-sub">${k.noShows} von ${k.total} Terminen</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Trinkgeld</div>
            <div class="stat-value" style="color:var(--gold)">${fmt(k.totalTips)}</div>
            <div class="stat-sub">gesamt ${label.toLowerCase()}</div>
          </div>
          ${buildUtilizationTile()}
        </div>
      </div>

      <!-- Reihe 1: Umsatzkönig + Service-König -->
      ${buildTopPerformer(k.byEmployee)}

      <!-- Reihe 2: Top Services -->
      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><h4>Top Services</h4><span style="font-size:0.75rem;color:var(--text-light)">${(() => { const d = new Date(dateFrom + 'T12:00:00'); return d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }) })()}</span></div>
        <div style="padding:0 0 4px">
          ${buildTopServicesChart()}
        </div>
      </div>

      <!-- Reihe 3: Mitarbeiter-Umsatz (live) -->
      ${buildEmployeeRevenueTable()}

      <!-- Reihe 4: Trinkgeld-Übersicht -->
      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><h4>Trinkgeld-Übersicht</h4><span style="font-size:0.75rem;color:var(--text-light)">${label}</span></div>
        <div style="padding:0 0 4px">
          ${buildTipSummary()}
        </div>
      </div>
    `
  }

  // ── Nachbuchungs-Modal ────────────────────────────────────────────────────

  function openBackfillModal() {
    const today  = localDate()
    const mStyle = 'padding:9px 12px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);font-size:0.9rem;width:100%;box-sizing:border-box;background:var(--white);color:var(--aubergine)'

    const CUSTOM_VAL = '__custom__'

    function treatOpts(locId) {
      const list     = treatments.filter(t => t.active !== false && (!locId || !t.location_id || t.location_id === locId))
      const baseOpts = list.map(t => `<option value="${t.id}" data-price="${t.price ?? 0}">${t.name} (${fmt(t.price)})</option>`).join('')
      return `<option value="">Behandlung wählen ...</option>` +
        `<option value="${CUSTOM_VAL}">[ Eigene Behandlung (Freitext) ]</option>` +
        baseOpts
    }

    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100dvh;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);padding:16px;box-sizing:border-box'

    overlay.innerHTML = `
      <div style="background:var(--white);border-radius:var(--radius-lg);max-width:480px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="padding:20px 24px 0">
          <h3 style="margin:0;font-size:1.1rem;color:var(--aubergine)">Behandlung nachtragen</h3>
          <div style="font-size:0.8rem;color:var(--text-light);margin-top:4px">Vergessene Buchung für ein vergangenes Datum einbuchen</div>
        </div>
        <div style="padding:20px 24px;display:flex;flex-direction:column;gap:14px">
          <label style="display:flex;flex-direction:column;gap:5px;font-size:0.875rem;font-weight:500;color:var(--aubergine)">
            Datum der Behandlung
            <input id="bf-date" type="date" value="${today}" style="${mStyle}">
          </label>
          <label style="display:flex;flex-direction:column;gap:5px;font-size:0.875rem;font-weight:500;color:var(--aubergine)">
            Mitarbeiter auswählen
            <select id="bf-employee" style="${mStyle}">
              <option value="">Mitarbeiter wählen ...</option>
              ${profiles.map(p => `<option value="${p.id}">${p.full_name}</option>`).join('')}
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:5px;font-size:0.875rem;font-weight:500;color:var(--aubergine)">
            Standort
            <select id="bf-location" style="${mStyle}">
              <option value="">Standort wählen ...</option>
              ${locations.map(l => `<option value="${l.id}">${l.name}</option>`).join('')}
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:5px;font-size:0.875rem;font-weight:500;color:var(--aubergine)">
            Behandlung
            <select id="bf-treatment" style="${mStyle}">
              <option value="">Zuerst Standort wählen ...</option>
            </select>
          </label>
          <div id="bf-custom-wrap" style="display:none">
            <label style="display:flex;flex-direction:column;gap:5px;font-size:0.875rem;font-weight:500;color:var(--aubergine)">
              Behandlungs-Name (Freitext) *
              <input id="bf-custom-name" type="text" maxlength="100" placeholder="z.B. Gel-Nails komplett" style="${mStyle}">
            </label>
          </div>
          <label style="display:flex;flex-direction:column;gap:5px;font-size:0.875rem;font-weight:500;color:var(--aubergine)">
            Preis in EUR
            <input id="bf-price" type="number" min="0" step="0.01" value="" placeholder="0.00" style="${mStyle}">
          </label>
          <div id="bf-msg" style="display:none;font-size:0.875rem;padding:10px 14px;border-radius:var(--radius-sm)"></div>
        </div>
        <div style="padding:0 24px 24px;display:flex;gap:10px">
          <button id="bf-save" class="btn btn-accent" style="font-size:0.9rem">[ Buchen ]</button>
          <button id="bf-cancel" class="btn btn-ghost" style="font-size:0.9rem">[ Abbrechen ]</button>
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    const msgEl     = overlay.querySelector('#bf-msg')
    const saveBtn   = overlay.querySelector('#bf-save')
    const locSel    = overlay.querySelector('#bf-location')
    const treatSel  = overlay.querySelector('#bf-treatment')
    const priceInp  = overlay.querySelector('#bf-price')

    function showMsg(text, isError = true) {
      msgEl.textContent      = text
      msgEl.style.display    = 'block'
      msgEl.style.background = isError ? '#fdecea' : '#e8f2e9'
      msgEl.style.color      = isError ? '#8b2e1a' : '#3a6b3f'
      msgEl.style.border     = `1px solid ${isError ? 'var(--terracotta)' : '#6B8F71'}`
    }

    const customWrap = overlay.querySelector('#bf-custom-wrap')
    const customName = overlay.querySelector('#bf-custom-name')

    locSel.addEventListener('change', () => {
      treatSel.innerHTML       = treatOpts(locSel.value)
      priceInp.value           = ''
      customWrap.style.display = 'none'
      customName.value         = ''
    })

    treatSel.addEventListener('change', () => {
      const isCustom = treatSel.value === CUSTOM_VAL
      customWrap.style.display = isCustom ? 'block' : 'none'
      if (isCustom) {
        priceInp.value = ''
      } else {
        const opt = treatSel.options[treatSel.selectedIndex]
        const p   = opt?.dataset?.price
        priceInp.value = (p != null && p !== '') ? Number(p).toFixed(2) : ''
      }
    })

    overlay.querySelector('#bf-cancel').addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

    saveBtn.addEventListener('click', async () => {
      const dateVal      = overlay.querySelector('#bf-date').value
      const employeeId   = overlay.querySelector('#bf-employee').value
      const locId        = locSel.value
      const treatId      = treatSel.value
      const price        = priceInp.value
      const isCustom     = treatId === CUSTOM_VAL
      const freitextName = customName.value.trim()

      msgEl.style.display = 'none'
      if (!dateVal)                              { showMsg('Bitte ein Datum wählen.');                   return }
      if (!employeeId)                           { showMsg('Bitte einen Mitarbeiter wählen.');           return }
      if (!locId)                                { showMsg('Bitte einen Standort wählen.');              return }
      if (!treatId)                              { showMsg('Bitte eine Behandlung wählen.');             return }
      if (isCustom && !freitextName)             { showMsg('Bitte einen Behandlungs-Namen eingeben.');   return }
      if (price === '' || isNaN(Number(price)))  { showMsg('Bitte einen gültigen Preis eingeben.');      return }

      saveBtn.disabled    = true
      saveBtn.textContent = '[ Wird gespeichert... ]'

      const { error } = await supabase.from('daily_revenue_logs').insert({
        created_at:     new Date(dateVal + 'T12:00:00').toISOString(),
        employee_id:    employeeId,
        location_id:    locId,
        treatment_id:   isCustom ? null : treatId,
        revenue:        Number(price),
        is_cancelled:   false,
        is_no_show:     false,
        payment_method: 'bar',
        tip:            0,
      })

      if (error) {
        showMsg('Fehler beim Speichern: ' + error.message)
        saveBtn.disabled    = false
        saveBtn.textContent = '[ Buchen ]'
        return
      }

      overlay.remove()
      showToast('Behandlung erfolgreich nachgebucht!')
      await Promise.all([loadLogs(), loadTarget(), loadHours(), loadTopServices()])
      rerender()
    })
  }

  function attachEvents() {
    const exportBtn = container.querySelector('#export-csv-btn')
    if (exportBtn) exportBtn.addEventListener('click', () => downloadControllingCsv(exportBtn))

    container.querySelector('#backfill-btn')?.addEventListener('click', openBackfillModal)

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
        localStorage.setItem('analyticsPeriod', period)
        localStorage.setItem('analyticsFrom', dateFrom)
        localStorage.setItem('analyticsTo', dateTo)
        await Promise.all([loadLogs(), loadTarget(), loadHours()])
        rerender()
      })
    })

    container.querySelector('#date-from')?.addEventListener('change', async e => {
      dateFrom = e.target.value || localDate()
      period = ''
      localStorage.setItem('analyticsFrom', dateFrom)
      await Promise.all([loadLogs(), loadTarget(), loadHours()])
      rerender()
    })
    container.querySelector('#date-to')?.addEventListener('change', async e => {
      dateTo = e.target.value || localDate()
      period = ''
      localStorage.setItem('analyticsTo', dateTo)
      await Promise.all([loadLogs(), loadTarget(), loadHours()])
      rerender()
    })

    container.querySelector('#analytics-location')?.addEventListener('change', async e => {
      selectedLocationId = e.target.value || 'all'
      localStorage.setItem('selectedLocationId', selectedLocationId)
      await Promise.all([loadLogs(), loadTarget(), loadHours()])
      rerender()
    })

    container.querySelector('#analytics-employee')?.addEventListener('change', e => {
      selectedEmployeeId = e.target.value || null
      rerender()
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

function localDate() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function fmt(n) {
  return Number(n ?? 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
}

function color(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16)
  const g = parseInt(hex.slice(3,5),16)
  const b = parseInt(hex.slice(5,7),16)
  return `rgba(${r},${g},${b},${alpha})`
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
