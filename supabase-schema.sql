-- =============================================
-- Studio 358 Performance Tracker – Supabase Schema
-- Ausführen in: Supabase Dashboard > SQL Editor
-- =============================================

-- PROFILES
CREATE TABLE IF NOT EXISTS profiles (
  id            UUID        REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  full_name     TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'employee', -- 'employee' | 'manager'
  is_manager    BOOLEAN     NOT NULL DEFAULT FALSE,
  level         TEXT        NOT NULL DEFAULT 'junior',   -- 'junior' | 'senior'
  location      TEXT,                                    -- 'mitte' | 'kadewe'
  skills        TEXT[]      NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PERFORMANCE ENTRIES
-- One row per manager evaluation. Self-assessment is written onto the same row
-- via the RPC function submit_self_assessment().
CREATE TABLE IF NOT EXISTS performance_entries (
  id                   UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id          UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  evaluator_id         UUID        REFERENCES profiles(id) ON DELETE SET NULL,

  -- Manager evaluation fields
  score                NUMERIC(3,1) NOT NULL DEFAULT 0,
  manager_scores       JSONB,                           -- { hygiene, technique, service, ... }
  manager_assessed_at  TIMESTAMPTZ,

  -- Self-assessment fields (written via RPC submit_self_assessment)
  self_scores          JSONB,                           -- same shape as manager_scores
  self_assessed_at     TIMESTAMPTZ,

  -- Legacy individual columns (kept for backward compatibility)
  creativity           NUMERIC(3,1) NOT NULL DEFAULT 0,
  reliability          NUMERIC(3,1) NOT NULL DEFAULT 0,
  productivity         NUMERIC(3,1) NOT NULL DEFAULT 0,

  -- Objective quality data
  appointments_count   INTEGER     NOT NULL DEFAULT 20,
  reworks_count        INTEGER     NOT NULL DEFAULT 0,
  punctuality_rate     NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  customer_feedback    NUMERIC(3,1),

  is_self_assessment   BOOLEAN     NOT NULL DEFAULT FALSE,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  evaluation_month     DATE        NOT NULL DEFAULT DATE_TRUNC('month', NOW())::DATE,
  UNIQUE (employee_id, evaluation_month)
);

-- SOPS (Standard Operating Procedures / Wissensdatenbank)
CREATE TABLE IF NOT EXISTS sops (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  title             TEXT        NOT NULL,
  content           TEXT,
  video_url         TEXT,
  file_url          TEXT,
  associated_skill  TEXT,       -- matches skill id from DEFAULT_SKILLS
  created_by        UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================
-- ROW LEVEL SECURITY
-- =============================================

ALTER TABLE profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sops        ENABLE ROW LEVEL SECURITY;

-- PROFILES: eigenes Profil lesen
CREATE POLICY "own_profile_read" ON profiles
  FOR SELECT USING (auth.uid() = id);

-- PROFILES: Manager lesen alle
CREATE POLICY "manager_read_all_profiles" ON profiles
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_manager = TRUE)
  );

-- PROFILES: Manager können updaten
CREATE POLICY "manager_update_profiles" ON profiles
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_manager = TRUE)
  );

-- PROFILES: Eigenes Profil einfügen (nach Auth-Registrierung)
CREATE POLICY "insert_own_profile" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- EVALUATIONS: Mitarbeiter lesen nur eigene
CREATE POLICY "employee_read_own_evals" ON evaluations
  FOR SELECT USING (auth.uid() = employee_id);

-- EVALUATIONS: Manager lesen alle
CREATE POLICY "manager_read_all_evals" ON evaluations
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_manager = TRUE)
  );

-- EVALUATIONS: Manager erstellen
CREATE POLICY "manager_insert_evals" ON evaluations
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_manager = TRUE)
  );

-- EVALUATIONS: Manager löschen
CREATE POLICY "manager_delete_evals" ON evaluations
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_manager = TRUE)
  );

-- SOPS: Alle authentifizierten Nutzer lesen
CREATE POLICY "authenticated_read_sops" ON sops
  FOR SELECT USING (auth.role() = 'authenticated');

-- SOPS: Manager verwalten
CREATE POLICY "manager_manage_sops" ON sops
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_manager = TRUE)
  );

-- =============================================
-- TRIGGER: updated_at automatisch setzen
-- =============================================

CREATE OR REPLACE FUNCTION handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sops_updated_at
  BEFORE UPDATE ON sops
  FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- =============================================
-- TRIGGER: Profil bei neuem Auth-User anlegen
-- =============================================

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, full_name, role, is_manager)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    COALESCE(NEW.raw_user_meta_data->>'role', 'employee'),
    COALESCE((NEW.raw_user_meta_data->>'is_manager')::BOOLEAN, FALSE)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- =============================================
-- BEISPIELDATEN (optional – nach Schema ausführen)
-- =============================================

-- Beispiel-SOP für Shellac
INSERT INTO sops (title, content, associated_skill) VALUES
  ('Shellac – Standardablauf',
   E'## Shellac Anwendung\n\n**Vorbereitung**\n- Nägel feilen und cuticles entfernen\n- Nagelplatte leicht aufrauen\n- pH-Bond auftragen\n\n**Auftrag**\n1. Base Coat: 10 Sek. UV/LED\n2. Farbe (Schicht 1): 60 Sek. UV / 30 Sek. LED\n3. Farbe (Schicht 2): 60 Sek. UV / 30 Sek. LED\n4. Top Coat: 120 Sek. UV / 60 Sek. LED\n\n**Qualitätsprüfung**\n- Glanz und Gleichmäßigkeit prüfen\n- Ränder kontrollieren',
   'shellac'),
  ('Gel Extensions – Dual Form',
   E'## Dual Form Technik\n\n**Material**\n- Dual Form Schablonen\n- Builder Gel (klar/rosa)\n- UV/LED Lampe\n\n**Ablauf**\n1. Dual Form auswählen und anpassen\n2. Builder Gel einfüllen\n3. Nagel positionieren, 60 Sek. aushärten\n4. Form entfernen, Form schleifen\n5. Finish mit Top Coat',
   'dual_form'),
  ('Klassische Maniküre',
   E'## Maniküre Ablauf\n\n1. Nägel in gewünschte Form feilen\n2. Nagelhaut einweichen (5 Min.)\n3. Nagelhaut vorsichtig schieben\n4. Handmassage mit Öl\n5. Lack nach Wunsch\n\n**Hinweis:** Immer sterilisierte Werkzeuge verwenden.',
   'manikuere')
ON CONFLICT DO NOTHING;
