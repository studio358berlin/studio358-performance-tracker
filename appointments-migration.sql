-- Manager Appointments table for 1:1 performance conversations
-- Run once in Supabase SQL editor

CREATE TABLE IF NOT EXISTS public.manager_appointments (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  manager_id     UUID REFERENCES public.profiles(id),
  scheduled_date DATE NOT NULL,
  scheduled_time TIME,
  type           TEXT NOT NULL DEFAULT 'offline',  -- 'online' | 'offline'
  location       TEXT,   -- e.g. 'mitte' | 'kadewe' for offline
  meet_link      TEXT,   -- Google Meet URL for online
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'pending_manager',
  -- status flow:
  --   'pending_manager'  → employee requested, awaiting manager response
  --   'pending_employee' → manager invited, awaiting employee confirmation
  --   'confirmed'        → both parties confirmed
  --   'cancelled'        → declined or cancelled
  initiated_by   UUID REFERENCES public.profiles(id),  -- UUID of user who created the appointment
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- If the table already exists but is missing initiated_by, add the column:
ALTER TABLE public.manager_appointments
  ADD COLUMN IF NOT EXISTS initiated_by UUID REFERENCES public.profiles(id);

ALTER TABLE public.manager_appointments ENABLE ROW LEVEL SECURITY;

-- Drop old policy if it exists, then recreate
DROP POLICY IF EXISTS "authenticated_all" ON public.manager_appointments;

CREATE POLICY "authenticated_all"
  ON public.manager_appointments
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
