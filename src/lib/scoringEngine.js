// ── Studio 358 Performance Model ──────────────────────────────────────────────
// Pure function, no external dependencies.
// All constants named; single export: calculatePerformance().

const CATEGORIES = {
  Sauberkeit_Hygiene:      { type: 'safety',      weight: 0.10 },
  Technische_Exzellenz:    { type: 'performance', weight: 0.25 },
  Kundenmanagement:        { type: 'performance', weight: 0.20 },
  Mentoring:               { type: 'performance', weight: 0.15 },
  Umsatz_Produktivitaet:   { type: 'performance', weight: 0.15 },
  Zuverlaessigkeit:        { type: 'safety',      weight: 0.10 },
  Kreativitaet_Innovation: { type: 'performance', weight: 0.05 },
}

const LEVEL_PARAMS = {
  Junior: { T_L: 3.5, V_L: 3.5 },
  Senior: { T_L: 5.0, V_L: 4.0 },
}

const BONUS_THRESHOLDS = { Gold: 96, Silber: 91, Bronze: 80 }

// ── Internal helpers ───────────────────────────────────────────────────────────

function quoteToScore(q) {
  if (q >= 1.0)  return 5
  if (q >= 0.95) return 4
  if (q >= 0.85) return 3
  if (q >= 0.75) return 2
  return 1
}

function nachbesserungenToScore(n) {
  if (n <= 0) return 5
  if (n <= 1) return 4
  if (n <= 2) return 3
  if (n <= 3) return 2
  return 1
}

function getBonusStufe(qpi) {
  if (qpi === null)                      return 'Kein Bonus'
  if (qpi >= BONUS_THRESHOLDS.Gold)      return 'Gold'
  if (qpi >= BONUS_THRESHOLDS.Silber)    return 'Silber'
  if (qpi >= BONUS_THRESHOLDS.Bronze)    return 'Bronze'
  return 'Kein Bonus'
}

function round1(n) { return Math.round(n * 10) / 10 }

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * @param {object}   input
 * @param {'Junior'|'Senior'} input.level
 * @param {object}   input.managerScores   - category keys → 1–5
 * @param {object}   [input.selfScores]    - same shape; falls back to managerScores
 * @param {object}   [input.objektiveDaten]
 * @param {number}     input.objektiveDaten.terminTreueQuote          0–1
 * @param {number}     input.objektiveDaten.arbeitsPuenktlichkeitsQuote 0–1
 * @param {number}     input.objektiveDaten.nachbesserungen
 * @param {number}     input.objektiveDaten.kundenfeedbackDurchschnitt 1–5
 * @param {number[]}  [input.previousPI]   - [PI_t-1, PI_t-2]; QPI requires exactly 2 values
 * @returns {object}
 */
export function calculatePerformance({ level, managerScores, selfScores, objektiveDaten, previousPI }) {
  const { T_L, V_L } = LEVEL_PARAMS[level] ?? LEVEL_PARAMS.Junior

  // Fallback: use manager scores when self-assessment is missing
  const self = selfScores ?? managerScores

  const hasObj = objektiveDaten != null

  // ── Step 4: Objective sub-scores ────────────────────────────────────────────

  let objZuv    = null
  let objTech   = null
  let objKunden = null

  if (hasObj) {
    const { terminTreueQuote, arbeitsPuenktlichkeitsQuote, nachbesserungen, kundenfeedbackDurchschnitt } = objektiveDaten
    objZuv    = (quoteToScore(terminTreueQuote) + quoteToScore(arbeitsPuenktlichkeitsQuote)) / 2
    objTech   = nachbesserungenToScore(nachbesserungen)
    objKunden = kundenfeedbackDurchschnitt
  }

  // ── Step 4: Combined scores C_k ─────────────────────────────────────────────

  const C = {}

  for (const key of Object.keys(CATEGORIES)) {
    const m = managerScores[key] ?? 3
    const s = self[key] ?? 3

    if (key === 'Zuverlaessigkeit') {
      const base = hasObj ? objZuv : m
      C[key] = 0.75 * base + 0.25 * s
    } else if (key === 'Technische_Exzellenz') {
      const base = hasObj ? (0.5 * objTech + 0.5 * m) : m
      C[key] = 0.75 * base + 0.25 * s
    } else if (key === 'Kundenmanagement') {
      const base = hasObj ? (0.5 * objKunden + 0.5 * m) : m
      C[key] = 0.75 * base + 0.25 * s
    } else {
      C[key] = 0.75 * m + 0.25 * s
    }
  }

  // ── Step 6: Global Safety Brake (Veto) ──────────────────────────────────────

  const hygieneCheck = managerScores['Sauberkeit_Hygiene'] ?? 0
  // Use objective Zuv score if available, otherwise fall back to manager score
  const zuvCheck     = hasObj ? objZuv : (managerScores['Zuverlaessigkeit'] ?? 0)
  const vetoAusgeloest = hygieneCheck < V_L || zuvCheck < V_L

  const objektiveScores = { Zuverlaessigkeit: objZuv, Technische_Exzellenz: objTech, Kundenmanagement: objKunden }

  if (vetoAusgeloest) {
    const qpi = (Array.isArray(previousPI) && previousPI.length >= 2) ? 0 : null
    return {
      PI_Monat:       0,
      QPI:            qpi,
      bonusStufe:     'Kein Bonus',
      vetoAusgeloest: true,
      details:        { C_k: C, E_k: null, D_k: null, delta: null, PI_vorSkala: null, objektiveScores },
    }
  }

  // ── Step 5: Senior Lever E_k ─────────────────────────────────────────────────

  const E = {}
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    E[key] = cat.type === 'performance'
      ? C[key] * Math.min(1, C[key] / T_L)
      : C[key]
  }

  // ── Step 7: Discrepancy Penalty ──────────────────────────────────────────────

  const D = {}
  for (const key of Object.keys(CATEGORIES)) {
    D[key] = Math.max(0, (self[key] ?? 3) - (managerScores[key] ?? 3) - 1.0)
  }
  const dMean = Object.values(D).reduce((s, v) => s + v, 0) / Object.keys(D).length
  const delta = Math.min(0.05, dMean * 0.05)

  // ── Step 7 + 8: PI_vorSkala → PI_Monat ──────────────────────────────────────

  let PI_vorSkala = 0
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    PI_vorSkala += cat.weight * E[key]
  }
  PI_vorSkala *= (1 - delta)

  const PI_Monat = Math.max(0, Math.min(100, (PI_vorSkala - 1) / 4 * 100))

  // ── Step 9: QPI ──────────────────────────────────────────────────────────────

  let QPI = null
  if (Array.isArray(previousPI) && previousPI.length >= 2) {
    const [pi1, pi2] = previousPI
    QPI = (pi1 === 0 || pi2 === 0) ? 0 : (PI_Monat + pi1 + pi2) / 3
  }

  // ── Step 10: Bonus level ─────────────────────────────────────────────────────

  return {
    PI_Monat:       round1(PI_Monat),
    QPI:            QPI !== null ? round1(QPI) : null,
    bonusStufe:     getBonusStufe(QPI),
    vetoAusgeloest: false,
    details:        { C_k: C, E_k: E, D_k: D, delta, PI_vorSkala, objektiveScores },
  }
}

// ── DB → Engine mapping ────────────────────────────────────────────────────────

/**
 * Maps a performance_entries row to calculatePerformance() input.
 * self_scores live on the same row as manager_scores (set via RPC submit_self_assessment).
 */
export function mapEntryToEngine(entry, level) {
  const ms  = entry.manager_scores ?? {}
  const lvl = (level === 'senior' || level === 'Senior') ? 'Senior' : 'Junior'

  const fallback = entry.score ?? 3

  const managerScores = {
    Sauberkeit_Hygiene:      ms.hygiene     ?? fallback,
    Technische_Exzellenz:    ms.technique   ?? fallback,
    Kundenmanagement:        ms.service     ?? fallback,
    Mentoring:               ms.mentoring   ?? fallback,
    Umsatz_Produktivitaet:   ms.revenue     ?? entry.productivity ?? fallback,
    Zuverlaessigkeit:        ms.punctuality ?? entry.reliability  ?? fallback,
    Kreativitaet_Innovation: ms.creativity  ?? entry.creativity   ?? fallback,
  }

  // self_scores are stored on the same row, written via RPC submit_self_assessment
  let selfScores = null
  if (entry.self_scores) {
    const ss = entry.self_scores
    selfScores = {
      Sauberkeit_Hygiene:      ss.hygiene     ?? managerScores.Sauberkeit_Hygiene,
      Technische_Exzellenz:    ss.technique   ?? managerScores.Technische_Exzellenz,
      Kundenmanagement:        ss.service     ?? managerScores.Kundenmanagement,
      Mentoring:               ss.mentoring   ?? managerScores.Mentoring,
      Umsatz_Produktivitaet:   ss.revenue     ?? managerScores.Umsatz_Produktivitaet,
      Zuverlaessigkeit:        ss.punctuality ?? managerScores.Zuverlaessigkeit,
      Kreativitaet_Innovation: ss.creativity  ?? managerScores.Kreativitaet_Innovation,
    }
  }

  const nachbesserungen            = entry.reworks_count ?? entry.complaints_count ?? 0
  const kundenfeedbackDurchschnitt = entry.customer_feedback ?? managerScores.Kundenmanagement

  const zuvScore   = managerScores.Zuverlaessigkeit
  const proxyQuote = zuvScore >= 5 ? 1.0 : zuvScore >= 4 ? 0.97 : zuvScore >= 3 ? 0.90 : zuvScore >= 2 ? 0.80 : 0.65

  const objektiveDaten = {
    terminTreueQuote:            proxyQuote,
    arbeitsPuenktlichkeitsQuote: proxyQuote,
    nachbesserungen,
    kundenfeedbackDurchschnitt,
  }

  return { level: lvl, managerScores, selfScores, objektiveDaten }
}

/**
 * Computes QPI from the three most recent evaluations.
 * Each evaluation row may contain self_scores alongside manager_scores.
 */
export function calcQPI(evaluations, level) {
  const sorted = [...evaluations].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  if (sorted.length < 3) return null

  const [e0, e1, e2] = sorted
  const pi0 = calculatePerformance(mapEntryToEngine(e0, level)).PI_Monat
  const pi1 = calculatePerformance(mapEntryToEngine(e1, level)).PI_Monat
  const pi2 = calculatePerformance(mapEntryToEngine(e2, level)).PI_Monat

  if (pi0 === 0 || pi1 === 0 || pi2 === 0) return 0
  return round1((pi0 + pi1 + pi2) / 3)
}
