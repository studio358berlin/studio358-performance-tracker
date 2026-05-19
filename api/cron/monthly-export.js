/**
 * Vercel Cron Job – runs at 00:01 on the 1st of every month (UTC).
 * Generates CSV reports for the previous month and uploads them to Google Drive.
 *
 * Required environment variables (set in Vercel Dashboard → Settings → Environment Variables):
 *   SUPABASE_URL                  – same value as VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY     – Supabase → Project Settings → API → service_role secret
 *   GOOGLE_SERVICE_ACCOUNT_JSON   – stringified JSON of Google service-account key file
 *   GOOGLE_DRIVE_FOLDER_ID        – ID of the target Google Drive folder
 *   CRON_SECRET                   – arbitrary secret to protect this endpoint (set same value in Vercel)
 */

import { createClient } from '@supabase/supabase-js'
import { google }        from 'googleapis'
import { Readable }      from 'node:stream'

// ── Auth guard ────────────────────────────────────────────────────────────────
function isAuthorized(req) {
  const secret = process.env.CRON_SECRET
  if (!secret) return true  // not configured → allow (Vercel Hobby plan)
  return req.headers.authorization === `Bearer ${secret}`
}

// ── CSV helpers ───────────────────────────────────────────────────────────────
const BOM = '﻿'

function buildRevenueCsv(logs) {
  const header = 'Datum;Mitarbeiter;Behandlung;Preis (€);Upsell (€);Trinkgeld (€);Zahlungsart;Status'
  const rows   = logs.map(l => {
    const date   = new Date(l.created_at).toLocaleDateString('de-DE')
    const emp    = (l.employee?.full_name ?? '–').replace(/;/g, ',')
    const treat  = (l.treatment?.name    ?? '–').replace(/;/g, ',')
    const price  = Number(l.revenue       ?? 0).toFixed(2).replace('.', ',')
    const upsell = Number(l.upsell_amount ?? 0).toFixed(2).replace('.', ',')
    const tip    = Number(l.tip           ?? 0).toFixed(2).replace('.', ',')
    const method = l.payment_method ?? '–'
    const status = l.is_cancelled ? 'STORNIERT' : l.is_no_show ? 'NO-SHOW' : 'OK'
    return `${date};${emp};${treat};${price};${upsell};${tip};${method};${status}`
  })
  return BOM + [header, ...rows].join('\n')
}

function buildHoursCsv(hours) {
  const header = 'Datum;Mitarbeiter;Arbeitsstunden;Pause (Min);Netto-Stunden'
  const rows   = hours.map(h => {
    const date   = new Date(h.date + 'T12:00:00').toLocaleDateString('de-DE')
    const emp    = (h.employee?.full_name ?? '–').replace(/;/g, ',')
    const worked = Number(h.hours_worked  ?? 0).toFixed(2).replace('.', ',')
    const pause  = Number(h.break_minutes ?? 0)
    const net    = Math.max(0, Number(h.hours_worked ?? 0) - Number(h.break_minutes ?? 0) / 60).toFixed(2).replace('.', ',')
    return `${date};${emp};${worked};${pause};${net}`
  })
  return BOM + [header, ...rows].join('\n')
}

// ── Google Drive upload ───────────────────────────────────────────────────────
async function uploadToDrive(drive, folderId, filename, csvContent) {
  // Remove existing file with same name to avoid duplicates
  const existing = await drive.files.list({
    q:      `name='${filename}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id)',
  })
  for (const f of (existing.data.files ?? [])) {
    await drive.files.delete({ fileId: f.id })
  }

  await drive.files.create({
    requestBody: {
      name:    filename,
      mimeType: 'text/csv',
      parents: [folderId],
    },
    media: {
      mimeType: 'text/csv',
      body:     Readable.from([Buffer.from(csvContent, 'utf-8')]),
    },
  })
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // Target: previous calendar month
  const now       = new Date()
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const year      = prevMonth.getFullYear()
  const month     = prevMonth.getMonth() + 1
  const mm        = String(month).padStart(2, '0')
  const firstDay  = `${year}-${mm}-01`
  const lastDate  = new Date(year, month, 0).getDate()
  const lastDay   = `${year}-${mm}-${String(lastDate).padStart(2, '0')}`

  // ── Supabase fetch ──────────────────────────────────────────────────────────
  let logs  = []
  let hours = []

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )

    const [logsRes, hoursRes] = await Promise.all([
      supabase.from('daily_revenue_logs')
        .select('*, employee:employee_id(full_name), treatment:treatment_id(name)')
        .gte('created_at', firstDay + 'T00:00:00')
        .lte('created_at', lastDay + 'T23:59:59')
        .order('created_at'),
      supabase.from('employee_daily_hours')
        .select('*, employee:employee_id(full_name)')
        .gte('date', firstDay)
        .lte('date', lastDay)
        .order('date'),
    ])

    if (logsRes.error)  throw new Error('Revenue logs: ' + logsRes.error.message)
    if (hoursRes.error) throw new Error('Hours: '        + hoursRes.error.message)

    logs  = logsRes.data  ?? []
    hours = hoursRes.data ?? []
  } catch (err) {
    console.error('[monthly-export] Supabase error:', err.message)
    return res.status(500).json({ error: 'Supabase fetch failed: ' + err.message })
  }

  // ── Google Drive upload ─────────────────────────────────────────────────────
  const driveConfigured =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON &&
    process.env.GOOGLE_DRIVE_FOLDER_ID

  if (!driveConfigured) {
    console.warn('[monthly-export] Google Drive env vars not set – skipping upload.')
    return res.status(200).json({
      ok:      true,
      warning: 'Drive upload skipped – GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_DRIVE_FOLDER_ID not set.',
      month:   `${mm}/${year}`,
      logs:    logs.length,
      hours:   hours.length,
    })
  }

  try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    })
    const drive    = google.drive({ version: 'v3', auth })
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID

    await Promise.all([
      uploadToDrive(drive, folderId, `Umsatzexport_${mm}_${year}.csv`,  buildRevenueCsv(logs)),
      uploadToDrive(drive, folderId, `Stundenkonto_${mm}_${year}.csv`,  buildHoursCsv(hours)),
    ])
  } catch (err) {
    console.error('[monthly-export] Google Drive error:', err.message)
    // Non-fatal: data was fetched, Drive upload failed → return 200 with warning
    return res.status(200).json({
      ok:      false,
      warning: 'Drive upload failed: ' + err.message,
      month:   `${mm}/${year}`,
      logs:    logs.length,
      hours:   hours.length,
    })
  }

  return res.status(200).json({
    ok:    true,
    month: `${mm}/${year}`,
    logs:  logs.length,
    hours: hours.length,
  })
}
