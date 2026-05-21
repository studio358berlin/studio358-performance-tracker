-- Audit fields for employee_daily_hours
-- Run once in Supabase SQL editor

ALTER TABLE public.employee_daily_hours
  ADD COLUMN IF NOT EXISTS is_modified        BOOLEAN    NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS original_hours_worked  NUMERIC,
  ADD COLUMN IF NOT EXISTS original_break_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS modified_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clock_in_time      TIMESTAMPTZ;
