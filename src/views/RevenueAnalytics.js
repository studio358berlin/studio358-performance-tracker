import { supabase } from '../lib/supabase.js'

// ── Revenue Analytics – Manager-only ─────────────────────────────────────────

export function RevenueAnalytics({ user }) {
  let locations   = []
  let logs        = []
  let profiles    = []
  let treatments  = []
  let dailyTarget = 0

  let selectedLocationId = user?.profile?.location_id ?? null
  let period = 'today'   // 'today' | 'week' | 'month'
  let container = null

  // ── Date helpers ──────────────────────────────────────────────────────────

  function dateRange() {
    const now   = new Date()
    const today = now.toISOString().slice(0, 10)
    if (period === 'today') return { from: today + 'T00:00:00', to: today + 'T23:59:59', label: 'Heute' }
    if (period === 'week') {
      const mon = new Date(now); mon.setDate(now.getDate() - now.getDay() + 1)
      return { from: mon.toISOString().slice(0, 10) + 'T00:00:00', to: today + 'T23:59:59', label: 'Diese Woche' }
    }
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    return { from: firstOfMonth.toISOString().slice(0, 10) + 'T00:00:00', to: today + 'T23:59:59', label: 'Dieser Monat' }
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  async function loadData() {
    const [locRes, profRes, treatRes] = await Promise.all([
      supabase.from('locations').select('*').order('name'),
      supabase.from('profiles').select('id, full_name').eq('is_manager', false),
      supabase.from('treatments').select('id, name').order('name'),
    ])
    locations  = locRes.data  ?? []
    profiles   = profRes.data ?? []
    treatments = treatRes.data ?? []

    if (!selectedLocationId && locations.length) selectedLocationId = locations[0].id
    await loadLogs()
    await loadTarget()
  }

  async function loadLogs() {
    const { from, to } = dateRange()
    let q = supabase
      .from('daily_revenue_logs')
      .select('*')
      .gte('created_at', from)
      .lte('created_at', to)

    if (selectedLocationId) q = q.eq('location_id', selectedLocationId)

    const { data } = await q
    logs = data ?? []
  }

  async function loadTarget() {
    if (!selectedLocationId) { dailyTarget = 0; return }

    // Check for today's override first
    const today = new Date().toISOString().slice(0, 10)
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

  // ── KPI calculations ──────────────────────────────────────────────────────

  function kpis() {
    const real    = logs.filter(l => !l.is_no_show)
    const noShows = logs.filter(l =>  l.is_no_show)

    const totalRevenue = real.reduce((s, l) => s + Number(l.revenue),       0)
    const totalTips    = logs.reduce((s, l)  => s + Number(l.tip),          0)
    const avgPerClient = real.length ? totalRevenue / real.length : 0
    const noShowRate   = logs.length ? (noShows.length / logs.length) * 100 : 0

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

  // ── Service-Frequenz bar chart ────────────────────────────────────────────

  function buildFrequencyChart(byTreatment) {
    const entries = Object.entries(byTreatment).sort((a, b) => b[1] - a[1])
    if (!entries.length) return `<div class="empty-state"><span class="empty-state-icon">◉</span><p>Keine Behandlungsdaten.</p></div>`

    const max = entries[0][1]
    return entries.map(([id, count]) => {
      const pct = max > 0 ? (count / max) * 100 : 0
      return `
        <div style="display:grid;grid-template-columns:140px 1fr 36px;align-items:center;gap:10px;margin-bottom:10px">
          <span class="freq-label" style="width:140px;font-size:0.82rem;color:var(--text-mid);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${treatName(id)}</span>
          <div style="background:var(--cream-dark);border-radius:4px;height:10px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:var(--aubergine);border-radius:4px;transition:width 0.4s ease"></div>
          </div>
          <span style="font-size:0.82rem;font-weight:600;color:var(--aubergine);text-align:right">${count}×</span>
        </div>
      `
    }).join('')
  }

  // ── Main HTML ─────────────────────────────────────────────────────────────

  function buildHTML() {
    const k = kpis()
    const { from, label } = dateRange()

    return `
      <div class="page-header">
        <div>
          <h2>Umsatz-Analytics</h2>
          <p style="color:var(--text-light);font-size:0.875rem">Manager-Übersicht · ${label}</p>
        </div>
      </div>

      <!-- Filter bar -->
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:24px">
        <div class="location-tabs" style="margin:0">
          <button class="location-tab ${period==='today' ? 'active':''}" data-period="today">Heute</button>
          <button class="location-tab ${period==='week'  ? 'active':''}" data-period="week">Woche</button>
          <button class="location-tab ${period==='month' ? 'active':''}" data-period="month">Monat</button>
        </div>
        <select id="analytics-location" style="padding:7px 12px;border:1px solid var(--cream-dark);border-radius:var(--radius-sm);background:var(--white);font-size:0.875rem">
          ${locations.map(l => `<option value="${l.id}" ${l.id===selectedLocationId?'selected':''}>${l.name}</option>`).join('')}
        </select>
      </div>

      <!-- Gauge + KPI tiles -->
      <div class="analytics-layout" style="display:grid;grid-template-columns:240px 1fr;gap:16px;margin-bottom:24px;align-items:start">
        <!-- Gauge: only meaningful for "today" -->
        <div class="card" style="padding:8px">
          <div style="text-align:center;font-size:0.72rem;font-weight:600;color:var(--text-light);letter-spacing:0.08em;text-transform:uppercase;padding-top:12px">Umsatz-Uhr</div>
          ${period === 'today'
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
        </div>
      </div>

      <!-- Top-Performer -->
      ${buildTopPerformer(k.byEmployee)}

      <!-- Service-Frequenz -->
      <div class="card">
        <div class="card-header"><h4>Service-Frequenz</h4><span style="font-size:0.75rem;color:var(--text-light)">${label}</span></div>
        <div style="padding:16px 20px">
          ${buildFrequencyChart(k.byTreatment)}
        </div>
      </div>
    `
  }

  function attachEvents() {
    container.querySelectorAll('.location-tab[data-period]').forEach(btn => {
      btn.addEventListener('click', async () => {
        period = btn.dataset.period
        await loadLogs()
        await loadTarget()
        rerender()
      })
    })

    container.querySelector('#analytics-location')?.addEventListener('change', async e => {
      selectedLocationId = e.target.value
      await loadLogs()
      await loadTarget()
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

function fmt(n) {
  return Number(n ?? 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
}

function color(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16)
  const g = parseInt(hex.slice(3,5),16)
  const b = parseInt(hex.slice(5,7),16)
  return `rgba(${r},${g},${b},${alpha})`
}
