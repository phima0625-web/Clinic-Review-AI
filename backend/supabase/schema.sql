-- Run once in Supabase: SQL Editor → New query → paste → Run

create table if not exists clinic_knowledge (
  id text primary key,
  question text not null,
  answer text not null,
  category text not null default 'Other',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists review_library (
  id text primary key,
  category text not null default 'Other',
  categories text[] not null default '{}',
  review_text text not null default '',
  context_text text not null default '',
  reply_text text not null default '',
  created_at timestamptz not null default now()
);

-- Migration for existing projects (run once in SQL Editor if table already exists):
-- alter table review_library add column if not exists categories text[] not null default '{}';
-- update review_library set categories = array[category]::text[] where categories = '{}' or categories is null;

create index if not exists idx_clinic_knowledge_updated
  on clinic_knowledge (updated_at desc);

create index if not exists idx_review_library_created
  on review_library (created_at desc);

create table if not exists ai_audit_sessions (
  id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  actor_role text not null,
  feature text not null,
  status text not null default 'in_progress',
  model text,
  review_preview text,
  token_totals jsonb not null default '{}',
  events jsonb not null default '[]'
);

create index if not exists idx_ai_audit_sessions_created
  on ai_audit_sessions (created_at desc);

-- Migration for existing projects (run once in SQL Editor if table already exists):
-- create table if not exists ai_audit_sessions ( ... same as above ... );
