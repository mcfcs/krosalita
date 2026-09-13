-- Krosalita — solve history (cross-device) + share codes for user-created puzzles.
-- Apply after 0002_social.sql.

-- ============================================================
-- SOLVE HISTORY
-- ============================================================
-- One row per (user, puzzle identity). The client is local-first: every solve is
-- written to localStorage, and this table is the cross-device mirror. `puzzle_key`
-- is the deterministic identity computed by src/lib/solves.js — see puzzleIdentity()
-- there for the exact scheme. It is opaque to the database on purpose: the server
-- never needs to recompute it, it only needs it to be stable and unique per user.
create table if not exists public.solves (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users on delete cascade,
  puzzle_key       text not null,                       -- deterministic puzzle identity
  content_hash     text,                                -- 128-bit hex of the answer grid (nullable)
  source           text not null default 'generated',   -- daily | generated | imported | shared
  title            text,
  seconds          int,                                 -- duration of the solve that produced this row
  best_seconds     int,                                 -- fastest solve of this puzzle seen on any device
  used_help        boolean not null default false,      -- check/reveal used on the recorded solve
  difficulty_score numeric,                             -- 0-100, nullable
  difficulty_label text,
  rows             int,
  cols             int,
  solve_count      int not null default 1,
  day              date,                                -- the device's local calendar day of the solve
  first_solved_at  timestamptz not null default now(),
  solved_at        timestamptz not null default now(),
  unique (user_id, puzzle_key)
);
create index if not exists solves_user_idx on public.solves (user_id, solved_at desc);
create index if not exists solves_user_source_idx on public.solves (user_id, source);
-- Lets the merge collapse rows that two devices named under different identity
-- tiers but that are provably the same grid.
create index if not exists solves_user_hash_idx on public.solves (user_id, content_hash)
  where content_hash is not null;

alter table public.solves enable row level security;

-- Solve history is strictly private. No public/leaderboard read here: a leaderboard
-- would need its own aggregate view with a controlled column list.
drop policy if exists solves_select on public.solves;
create policy solves_select on public.solves
  for select using (user_id = auth.uid());
drop policy if exists solves_insert on public.solves;
create policy solves_insert on public.solves
  for insert with check (user_id = auth.uid());
drop policy if exists solves_update on public.solves;
create policy solves_update on public.solves
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists solves_delete on public.solves;
create policy solves_delete on public.solves
  for delete using (user_id = auth.uid());

-- ============================================================
-- SHARE CODES
-- ============================================================
alter table public.puzzles
  add column if not exists share_code text,
  add column if not exists shared_at  timestamptz;

-- Partial unique index: many rows may have no code, at most one row per code.
create unique index if not exists puzzles_share_code_key
  on public.puzzles (share_code) where share_code is not null;

-- ------------------------------------------------------------
-- Why the read policy is being tightened.
--
-- 0001's puzzles_read was `owner_id = auth.uid() or is_public = true`. PostgREST
-- exposes the table directly, so with that policy ANY anonymous client could run
--     select id, share_code, data from puzzles
-- and walk every published puzzle *and every share code*. RLS is row-level, not
-- column-level, so there is no way to keep share_code out of that result while the
-- row itself is readable.
--
-- A share code is a capability: knowing it should be the only way to reach the
-- puzzle. A capability that can be listed is not a capability. So the table stops
-- being anon-readable at all, and the two legitimate reads get purpose-built
-- security-definer RPCs that take their input as an *argument* rather than as a
-- client-controlled WHERE clause:
--   * get_puzzle_by_code(code) — you must already hold the code; returns 0 or 1 row.
--   * list_public_puzzles()    — the discovery surface 0001 implied, minus share_code.
-- RLS cannot express "only if you supplied the secret in your filter", because the
-- filter is chosen by the caller and can simply be omitted. A function argument
-- cannot be omitted.
-- ------------------------------------------------------------
drop policy if exists puzzles_read on public.puzzles;
create policy puzzles_read on public.puzzles
  for select using (owner_id = auth.uid());

-- Server-side normalisation, mirrored by normalizeCode() in src/lib/shareCode.js.
-- Codes are stored canonical (8 chars, uppercase, no separator); this makes a
-- lowercased / dashed / space-padded code still match.
create or replace function public.normalize_share_code(p_code text)
returns text language sql immutable as $$
  select nullif(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), '');
$$;

-- The only way an anonymous visitor reaches a shared puzzle. Returns at most one
-- row, and only for an exact code match, so the table stays unenumerable.
create or replace function public.get_puzzle_by_code(p_code text)
returns table (
  id uuid, title text, data jsonb, share_code text,
  created_at timestamptz, shared_at timestamptz, author text
)
language sql stable security definer set search_path = public as $$
  select p.id, p.title, p.data, p.share_code, p.created_at, p.shared_at,
         coalesce(pr.display_name, '')
  from public.puzzles p
  left join public.profiles pr on pr.id = p.owner_id
  where p.share_code is not null
    and p.share_code = public.normalize_share_code(p_code)
  limit 1;
$$;

-- A blank or garbage code must not degrade into "return everything":
-- normalize_share_code() yields null for those, `share_code = null` is never true,
-- and the `share_code is not null` predicate excludes unshared rows outright — so
-- the result is empty rather than arbitrary.
revoke all on function public.get_puzzle_by_code(text) from public;
grant execute on function public.get_puzzle_by_code(text) to anon, authenticated;

-- Replacement for the `is_public = true` read that the policy above removed.
-- Deliberately does NOT select share_code.
create or replace function public.list_public_puzzles(p_limit int default 50, p_offset int default 0)
returns table (id uuid, title text, created_at timestamptz, author text)
language sql stable security definer set search_path = public as $$
  select p.id, p.title, p.created_at, coalesce(pr.display_name, '')
  from public.puzzles p
  left join public.profiles pr on pr.id = p.owner_id
  where p.is_public = true
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$$;
revoke all on function public.list_public_puzzles(int, int) from public;
grant execute on function public.list_public_puzzles(int, int) to anon, authenticated;

-- Assigns a code inside the database so the uniqueness retry is a single round
-- trip and never races. The client may pass a candidate (generated from its own
-- non-confusable alphabet); on collision the database retries with a fresh one.
-- Runs as the caller — no security definer — so puzzles_update still enforces
-- that only the owner can publish. is_public is deliberately untouched: a share
-- code is a private capability, public listing is a separate, explicit choice.
create or replace function public.claim_share_code(p_puzzle uuid, p_code text)
returns text language plpgsql as $$
declare
  v_code text := public.normalize_share_code(p_code);
  v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_try int := 0;
  v_existing text;
begin
  select share_code into v_existing from public.puzzles
   where id = p_puzzle and owner_id = auth.uid();
  if not found then
    raise exception 'Puzzle not found or not yours.' using errcode = '42501';
  end if;
  if v_existing is not null then
    return v_existing;                       -- publishing twice is idempotent
  end if;

  loop
    v_try := v_try + 1;
    if v_code is null or length(v_code) <> 8 then
      v_code := '';
      for _i in 1..8 loop
        v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
      end loop;
    end if;
    begin
      update public.puzzles
         set share_code = v_code, shared_at = now()
       where id = p_puzzle and owner_id = auth.uid();
      -- RLS turns a non-owner update into zero rows rather than an error, so the
      -- ownership check is re-asserted here instead of trusting the select above.
      if not found then
        raise exception 'Puzzle not found or not yours.' using errcode = '42501';
      end if;
      return v_code;
    exception when unique_violation then
      v_code := null;                        -- force a fresh candidate
      if v_try >= 12 then
        raise exception 'Could not allocate a share code, please retry.';
      end if;
    end;
  end loop;
end; $$;
revoke all on function public.claim_share_code(uuid, text) from public;
grant execute on function public.claim_share_code(uuid, text) to authenticated;
