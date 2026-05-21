-- Minimal audit fields for employee_daily_hours
-- Run once in Supabase SQL editor

ALTER TABLE public.employee_daily_hours
  ADD COLUMN IF NOT EXISTS is_modified    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS original_hours TEXT;
