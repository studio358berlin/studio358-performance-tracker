export const DEFAULT_SKILLS = [
  // Treatments
  { id: 'shellac',       label: 'Shellac',         icon: '◆', category: 'nails',     color: '#B5573A' },
  { id: 'gel',           label: 'Gel',             icon: '◇', category: 'nails',     color: '#3D2B35' },
  { id: 'dual_form',     label: 'Dual Form',       icon: '▲', category: 'nails',     color: '#6B5060' },
  { id: 'manikuere',     label: 'Maniküre',        icon: '○', category: 'care',      color: '#D4935A' },
  { id: 'pediküre',      label: 'Pediküre',        icon: '◎', category: 'care',      color: '#8B6070' },
  { id: 'ibx',           label: 'IBX Treatment',   icon: '✦', category: 'treatment', color: '#4A7B6F' },
  // Studio Standards
  { id: 'HYGIENE',       label: 'Hygiene',         icon: '',  category: 'studio',    color: '#4A7B6F' },
  { id: 'STUDIO-KNIGGE', label: 'Studio-Knigge',   icon: '',  category: 'studio',    color: '#6B5060' },
  { id: 'PROZESSE',      label: 'Prozesse',         icon: '',  category: 'studio',    color: '#8B6070' },
]

export const PROMOTION_REQUIREMENTS = {
  minAvgScore:      4.0,
  minEvaluations:   3,
  requiredSkills:   ['shellac', 'gel', 'manikuere'],
}

export function getAllSkills(customSkills = []) {
  const defaults = DEFAULT_SKILLS.map(s => s.id)
  const extras = customSkills
    .filter(s => !defaults.includes(s))
    .map(s => ({
      id: s,
      label: s.charAt(0).toUpperCase() + s.slice(1),
      icon: '◉',
      category: 'custom',
      color: '#A08090',
    }))
  return [...DEFAULT_SKILLS, ...extras]
}

export function checkPromotionEligibility(employee, evaluations) {
  const { minAvgScore, minEvaluations, requiredSkills } = PROMOTION_REQUIREMENTS

  if (employee.level !== 'junior') {
    return { eligible: false, alreadySenior: true, reason: 'Bereits Senior' }
  }

  if (evaluations.length < minEvaluations) {
    return {
      eligible: false,
      reason: `Mindestens ${minEvaluations} Bewertungen erforderlich (aktuell: ${evaluations.length})`,
      checks: { evaluations: false, score: null, skills: null },
    }
  }

  const avgScore =
    evaluations.reduce((sum, e) => sum + Number(e.score), 0) / evaluations.length
  const scoreOk = avgScore >= minAvgScore

  const empSkills = employee.skills || []
  const missingSkills = requiredSkills.filter(s => !empSkills.includes(s))
  const skillsOk = missingSkills.length === 0

  const eligible = scoreOk && skillsOk

  const reasons = []
  if (!scoreOk)    reasons.push(`Ø Score ${avgScore.toFixed(1)} (mind. ${minAvgScore})`)
  if (!skillsOk)   reasons.push(`Fehlende Skills: ${missingSkills.join(', ')}`)

  return {
    eligible,
    avgScore: Math.round(avgScore * 10) / 10,
    missingSkills,
    reason: eligible ? 'Alle Kriterien erfüllt ✓' : reasons.join(' · '),
    checks: {
      evaluations: true,
      score: scoreOk,
      skills: skillsOk,
    },
  }
}
