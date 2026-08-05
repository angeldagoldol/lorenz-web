// ============================================================
// Fill these in from your Supabase project:
// Dashboard → Project Settings → API
//   - "Project URL"           → SUPABASE_URL
//   - "anon" "public" API key → SUPABASE_ANON_KEY
//
// IMPORTANT: SUPABASE_URL must be the bare project URL with NO path
// after it (no "/rest/v1/", no trailing slash needed). The Supabase
// client library appends /rest/v1/, /auth/v1/, /storage/v1/ etc. on
// its own depending on what you're calling. If you leave a path on
// the end, every request (including login) gets a malformed URL and
// silently fails.
//
// The anon key is safe to ship in client-side JS — it's designed for that.
// Row Level Security (set up by supabase-schema.sql) is what actually
// keeps people from reading each other's data, not secrecy of this key.
// ============================================================

const SUPABASE_URL = "https://rvrjkfbenramappteuae.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2cmprZmJlbnJhbWFwcHRldWFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MzQ3MjcsImV4cCI6MjEwMTAxMDcyN30.mLK_9vEMZ6BHsAYwRGohdirpIKKo9JGji7qJORkhmbs";