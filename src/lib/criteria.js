export const CRITERIA = {
  junior: [
    {
      id: 'hygiene',
      label: 'Sauberkeit & Hygiene',
      description: 'Arbeitsplatz, Werkzeuge, persönliche Hygiene',
      weight: 0.20,
    },
    {
      id: 'technique',
      label: 'Technische Ausführung',
      description: 'Präzision, Qualität der Nailart, Finish',
      weight: 0.25,
    },
    {
      id: 'service',
      label: 'Kundenservice',
      description: 'Freundlichkeit, Beratung, Kundenzufriedenheit',
      weight: 0.20,
    },
    {
      id: 'punctuality',
      label: 'Pünktlichkeit & Zuverlässigkeit',
      description: 'Einhaltung von Terminen und Arbeitszeiten',
      weight: 0.15,
    },
    {
      id: 'teamwork',
      label: 'Teamarbeit',
      description: 'Kooperation, Kommunikation, Unterstützung',
      weight: 0.10,
    },
    {
      id: 'learning',
      label: 'Lernbereitschaft',
      description: 'Offenheit für Feedback, Weiterentwicklung',
      weight: 0.10,
    },
  ],

  senior: [
    {
      id: 'hygiene',
      label: 'Sauberkeit & Hygiene',
      description: 'Professionelle Standards & Vorbildfunktion',
      weight: 0.10,
    },
    {
      id: 'technique',
      label: 'Technische Exzellenz',
      description: 'Komplexe Designs, Innovation, Perfektion',
      weight: 0.25,
    },
    {
      id: 'service',
      label: 'Kundenmanagement',
      description: 'Kundenbindung, Upselling, Beschwerdehandling',
      weight: 0.20,
    },
    {
      id: 'mentoring',
      label: 'Mentoring',
      description: 'Anleitung von Juniors, Wissensweitergabe',
      weight: 0.15,
    },
    {
      id: 'revenue',
      label: 'Umsatz & Produktivität',
      description: 'Zielerreichung, Auslastung, Produktverkauf',
      weight: 0.15,
    },
    {
      id: 'punctuality',
      label: 'Zuverlässigkeit',
      description: 'Termintreue, Selbstständigkeit, Verantwortung',
      weight: 0.10,
    },
    {
      id: 'creativity',
      label: 'Kreativität & Innovation',
      description: 'Neue Trends, eigene Designs, Inspiration',
      weight: 0.05,
    },
  ],
}

export function getCriteriaForLevel(level) {
  return CRITERIA[level] ?? CRITERIA.junior
}

export const SCORE_LABELS = {
  1: 'Verbesserungsbedarf',
  2: 'Ausbaufähig',
  3: 'Erfüllt Erwartungen',
  4: 'Übertrifft Erwartungen',
  5: 'Ausgezeichnet',
}
