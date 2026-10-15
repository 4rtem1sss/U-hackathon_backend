-- Demo seed (kept minimal on purpose).
--
-- Recipients are created per demo session by part 2's session helper (each new
-- session gets its own synthetic Thai recipient), so there is no global fixture
-- row here. This file must stay idempotent: `pnpm db:seed` may run repeatedly.
SELECT 1;
