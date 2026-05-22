-- Phase 2: Extend manager_appointments with protocol, sign-off and performance snapshot
-- Run once in Supabase SQL editor

ALTER TABLE public.manager_appointments
  ADD COLUMN IF NOT EXISTS performance_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS protocol_text        TEXT,
  ADD COLUMN IF NOT EXISTS transcript_text      TEXT,
  ADD COLUMN IF NOT EXISTS is_signed_off        BOOLEAN NOT NULL DEFAULT FALSE;
