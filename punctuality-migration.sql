-- Vertrauens-Pünktlichkeits-Tracking (Eigenauskunft)
-- Ausführen in Supabase SQL Editor (einmalig)

ALTER TABLE public.employee_daily_hours
  ADD COLUMN IF NOT EXISTS was_late     BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS late_comment TEXT;
