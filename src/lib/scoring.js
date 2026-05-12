import { getCriteriaForLevel, SCORE_LABELS } from './criteria.js'

// ── Weighted Score ──────────────────────────────────────────────────────────

export function calcWeightedScore(scores, level) {
  const criteria = getCriteriaForLevel(level)
  let total = 0
  for (const c of criteria) {
    total += (scores[c.id] ?? 0) * c.weight
  }
  return Math.round(total * 10) / 10
}

// ── Quality Rate ────────────────────────────────────────────────────────────

export function calcQualityRate(evaluations) {
  if (!evaluations?.length) return null

  const totalAppointments = evaluations.reduce(
    (sum, e) => sum + (e.appointments_count ?? 20), 0
  )
  const totalReclamations = evaluations.reduce(
    (sum, e) => sum + (e.complaints_count ?? 0), 0
  )

  if (totalAppointments === 0) return 100
  const rate = ((totalAppointments - totalReclamations) / totalAppointments) * 100
  return Math.round(Math.max(0, Math.min(100, rate)) * 10) / 10
}

export function calcTotalReclamations(evaluations) {
  return evaluations?.reduce((sum, e) => sum + (e.complaints_count ?? 0), 0) ?? 0
}

// ── Trend ───────────────────────────────────────────────────────────────────

export function getTrend(evaluations) {
  if (!evaluations || evaluations.length < 2) return null

  const sorted = [...evaluations].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  )

  const latest   = Number(sorted[0].score)
  const previous = Number(sorted[1].score)
  const diff     = Math.round((latest - previous) * 10) / 10

  if (diff > 0.1)  return { direction: 'up',   diff: `+${diff}`, label: 'Verbessert' }
  if (diff < -0.1) return { direction: 'down', diff: `${diff}`,  label: 'Gesunken'   }
  return               { direction: 'flat', diff: '±0',     label: 'Stabil'     }
}

export function getTrendHTML(trend) {
  if (!trend) return '<span class="trend trend-flat">–</span>'
  const icons = { up: '↑', down: '↓', flat: '→' }
  const cls   = { up: 'trend-up', down: 'trend-down', flat: 'trend-flat' }
  return `<span class="trend ${cls[trend.direction]}">${icons[trend.direction]} ${trend.diff}</span>`
}

// ── Labels & Colors ─────────────────────────────────────────────────────────

export function getScoreLabel(score) {
  return SCORE_LABELS[Math.round(score)] ?? 'Nicht bewertet'
}

export function getScoreColor(score) {
  if (score >= 4.5) return '#6B8F71'
  if (score >= 3.5) return '#D4935A'
  if (score >= 2.5) return '#B5573A'
  return '#8b2e1a'
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function formatScore(score) {
  return Number(score).toFixed(1)
}

export function scoreToPercent(score, max = 5) {
  return Math.round((score / max) * 100)
}

export function getLatestScore(evaluations) {
  if (!evaluations?.length) return null
  return Number([...evaluations].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  )[0].score) ?? 0
}

// ── Chart data ───────────────────────────────────────────────────────────────

export function getChartData(evaluations) {
  const sorted = [...(evaluations ?? [])].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  )
  return {
    labels: sorted.map(e =>
      new Date(e.created_at).toLocaleDateString('de-DE', { month: 'short', year: '2-digit' })
    ),
    scores:       sorted.map(e => Number(e.score)),
    reclamations: sorted.map(e => e.complaints_count ?? 0),
  }
}

// ── Learning Triggers ────────────────────────────────────────────────────────
// Returns criterion IDs where the latest score is below threshold

export function getLowScoringCriteria(evaluations, threshold = 3) {
  if (!evaluations?.length) return []

  const latest = [...evaluations].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  )[0]

  const scores = latest?.manager_scores ?? latest?.scores
  if (!scores) return []

  return Object.entries(scores)
    .filter(([, val]) => val < threshold)
    .map(([id]) => id)
}
