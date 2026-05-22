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
  review_text text not null default '',
  context_text text not null default '',
  reply_text text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_clinic_knowledge_updated
  on clinic_knowledge (updated_at desc);

create index if not exists idx_review_library_created
  on review_library (created_at desc);
