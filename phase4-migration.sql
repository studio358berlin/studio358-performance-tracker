-- =============================================
-- Phase 4 Migration – Studio 358
-- Run in: Supabase Dashboard > SQL Editor
-- =============================================

-- ── 1. LOCATIONS ──────────────────────────────
CREATE TABLE IF NOT EXISTS locations (
  id                   UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  name                 TEXT        NOT NULL,
  slug                 TEXT        UNIQUE NOT NULL,
  daily_revenue_target NUMERIC     NOT NULL DEFAULT 0 CHECK (daily_revenue_target >= 0),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS daily_revenue_target NUMERIC NOT NULL DEFAULT 0 CHECK (daily_revenue_target >= 0);

-- Seed default locations if empty
INSERT INTO locations (name, slug, daily_revenue_target)
VALUES ('Mitte', 'mitte', 1200), ('KaDeWe', 'kadewe', 1500)
ON CONFLICT (slug) DO NOTHING;

-- ── 2. TREATMENTS ─────────────────────────────
CREATE TABLE IF NOT EXISTS treatments (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  name       TEXT        NOT NULL,
  price      NUMERIC     NOT NULL DEFAULT 0 CHECK (price >= 0),
  duration   INTEGER     NOT NULL DEFAULT 60, -- minutes
  location_id UUID       REFERENCES locations(id) ON DELETE SET NULL,
  active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE treatments
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE SET NULL;

-- ── 3. DAILY_REVENUE_LOGS ─────────────────────
CREATE TABLE IF NOT EXISTS daily_revenue_logs (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id   UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  location_id   UUID        NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  treatment_id  UUID        REFERENCES treatments(id) ON DELETE RESTRICT,
  revenue       NUMERIC     NOT NULL DEFAULT 0 CHECK (revenue >= 0),
  upsell_amount NUMERIC     NOT NULL DEFAULT 0 CHECK (upsell_amount >= 0),
  tip           NUMERIC     NOT NULL DEFAULT 0 CHECK (tip >= 0),
  is_no_show    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_by    UUID        NOT NULL REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No-show constraint: when is_no_show = true, all monetary fields must be 0
ALTER TABLE daily_revenue_logs
  DROP CONSTRAINT IF EXISTS no_show_zero_amounts;
ALTER TABLE daily_revenue_logs
  ADD CONSTRAINT no_show_zero_amounts CHECK (
    NOT is_no_show OR (revenue = 0 AND upsell_amount = 0 AND tip = 0)
  );

-- ── 4. DAILY_TARGETS ──────────────────────────
CREATE TABLE IF NOT EXISTS daily_targets (
  id              UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  location_id     UUID    NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date            DATE    NOT NULL,
  target_override NUMERIC NOT NULL CHECK (target_override >= 0),
  UNIQUE (location_id, date)
);

-- ── 5. ADD location_id to profiles ────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS total_revenue_current_month NUMERIC NOT NULL DEFAULT 0;

-- ── 6. TRIGGER: Recalculate monthly revenue ───
CREATE OR REPLACE FUNCTION recalc_monthly_revenue()
RETURNS TRIGGER AS $$
DECLARE
  affected_employee UUID;
BEGIN
  -- Determine which employee was affected
  IF TG_OP = 'DELETE' THEN
    affected_employee := OLD.employee_id;
  ELSE
    affected_employee := NEW.employee_id;
  END IF;

  UPDATE profiles
  SET total_revenue_current_month = COALESCE((
    SELECT SUM(revenue)
    FROM daily_revenue_logs
    WHERE employee_id = affected_employee
      AND is_no_show  = FALSE
      AND date_trunc('month', created_at) = date_trunc('month', NOW())
  ), 0)
  WHERE id = affected_employee;

  RETURN NULL; -- AFTER trigger, return value ignored
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_recalc_monthly_revenue ON daily_revenue_logs;
CREATE TRIGGER trg_recalc_monthly_revenue
  AFTER INSERT OR UPDATE OR DELETE ON daily_revenue_logs
  FOR EACH ROW EXECUTE FUNCTION recalc_monthly_revenue();

-- ── 7. TRIGGER: Prevent hard-delete of referenced treatments ──
CREATE OR REPLACE FUNCTION prevent_treatment_hard_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM daily_revenue_logs WHERE treatment_id = OLD.id LIMIT 1) THEN
    RAISE EXCEPTION 'Treatment has existing revenue logs. Set active = false instead of deleting.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_treatment_delete ON treatments;
CREATE TRIGGER trg_prevent_treatment_delete
  BEFORE DELETE ON treatments
  FOR EACH ROW EXECUTE FUNCTION prevent_treatment_hard_delete();

-- ── 8. TRIGGER: Server-side same-day edit guard ───
CREATE OR REPLACE FUNCTION guard_same_day_edit()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.created_at::date <> CURRENT_DATE THEN
    RAISE EXCEPTION 'Revenue log entries can only be edited on the day they were created.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_same_day_update ON daily_revenue_logs;
CREATE TRIGGER trg_guard_same_day_update
  BEFORE UPDATE ON daily_revenue_logs
  FOR EACH ROW EXECUTE FUNCTION guard_same_day_edit();

DROP TRIGGER IF EXISTS trg_guard_same_day_delete ON daily_revenue_logs;
CREATE TRIGGER trg_guard_same_day_delete
  BEFORE DELETE ON daily_revenue_logs
  FOR EACH ROW EXECUTE FUNCTION guard_same_day_edit();

-- ── 9. RLS ────────────────────────────────────
ALTER TABLE daily_revenue_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE treatments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_targets       ENABLE ROW LEVEL SECURITY;

-- LOCATIONS: all authenticated users can read
DROP POLICY IF EXISTS "locations_read" ON locations;
CREATE POLICY "locations_read" ON locations
  FOR SELECT USING (auth.role() = 'authenticated');

-- LOCATIONS: manager can manage
DROP POLICY IF EXISTS "locations_manager_write" ON locations;
CREATE POLICY "locations_manager_write" ON locations
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_manager = TRUE)
  );

-- TREATMENTS: all authenticated users can read active
DROP POLICY IF EXISTS "treatments_read" ON treatments;
CREATE POLICY "treatments_read" ON treatments
  FOR SELECT USING (auth.role() = 'authenticated');

-- TREATMENTS: manager can write
DROP POLICY IF EXISTS "treatments_manager_write" ON treatments;
CREATE POLICY "treatments_manager_write" ON treatments
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_manager = TRUE)
  );

-- DAILY_REVENUE_LOGS: employee sees own entries
DROP POLICY IF EXISTS "revenue_logs_employee_read" ON daily_revenue_logs;
CREATE POLICY "revenue_logs_employee_read" ON daily_revenue_logs
  FOR SELECT USING (employee_id = auth.uid());

-- DAILY_REVENUE_LOGS: manager sees all entries at their location (or all if no location_id set)
DROP POLICY IF EXISTS "revenue_logs_manager_read" ON daily_revenue_logs;
CREATE POLICY "revenue_logs_manager_read" ON daily_revenue_logs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.is_manager = TRUE
        AND (p.location_id IS NULL OR p.location_id = daily_revenue_logs.location_id)
    )
  );

-- DAILY_REVENUE_LOGS: employees can insert own entries
DROP POLICY IF EXISTS "revenue_logs_insert" ON daily_revenue_logs;
CREATE POLICY "revenue_logs_insert" ON daily_revenue_logs
  FOR INSERT WITH CHECK (
    employee_id = auth.uid() AND created_by = auth.uid()
  );

-- DAILY_REVENUE_LOGS: employee can update/delete only own same-day entries (server trigger also checks)
DROP POLICY IF EXISTS "revenue_logs_employee_update" ON daily_revenue_logs;
CREATE POLICY "revenue_logs_employee_update" ON daily_revenue_logs
  FOR UPDATE USING (employee_id = auth.uid());

DROP POLICY IF EXISTS "revenue_logs_employee_delete" ON daily_revenue_logs;
CREATE POLICY "revenue_logs_employee_delete" ON daily_revenue_logs
  FOR DELETE USING (employee_id = auth.uid());

-- DAILY_REVENUE_LOGS: manager can update/delete any entry at their location
DROP POLICY IF EXISTS "revenue_logs_manager_write" ON daily_revenue_logs;
CREATE POLICY "revenue_logs_manager_write" ON daily_revenue_logs
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.is_manager = TRUE
        AND (p.location_id IS NULL OR p.location_id = daily_revenue_logs.location_id)
    )
  );

-- DAILY_TARGETS: all authenticated read, manager write
DROP POLICY IF EXISTS "daily_targets_read" ON daily_targets;
CREATE POLICY "daily_targets_read" ON daily_targets
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "daily_targets_manager_write" ON daily_targets;
CREATE POLICY "daily_targets_manager_write" ON daily_targets
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_manager = TRUE)
  );
