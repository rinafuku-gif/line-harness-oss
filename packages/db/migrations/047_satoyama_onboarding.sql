-- Migration 047: SATOYAMA AI BASE friend-add onboarding
--
-- This is intentionally separate from generic forms. The current profile row
-- stores the latest answers and reminder state; answer_events is append-only
-- history keyed by an idempotency key.
--
-- Production is fail-closed until the Worker environment explicitly enables
-- the feature for one line_account_id.

-- SQLite requires an explicit UNIQUE parent key for a composite foreign key.
-- This lets the onboarding tables enforce friend/account ownership in the DB.
CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_id_line_account
  ON friends (id, line_account_id);

CREATE INDEX IF NOT EXISTS idx_friends_line_account_follow_updated
  ON friends (line_account_id, is_following, updated_at);

CREATE TABLE IF NOT EXISTS satoyama_onboarding_states (
  line_account_id          TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id                TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  program_version          INTEGER NOT NULL DEFAULT 1,
  status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'started', 'completed', 'skipped')),
  issue_code               TEXT
                             CHECK (issue_code IS NULL OR issue_code IN (
                               'key_person', 'handoff', 'unsure_start', 'safe_rules', 'automation'
                             )),
  role_code                TEXT
                             CHECK (role_code IS NULL OR role_code IN (
                               'owner', 'internal_lead', 'frontline', 'supporter_solo'
                             )),
  area_code                TEXT
                             CHECK (area_code IS NULL OR area_code IN (
                               'admin', 'sales', 'hiring_training', 'content', 'undecided'
                             )),
  common_bonus_opened_at   TEXT,
  questions_started_at     TEXT,
  issue_bonus_opened_at    TEXT,
  cta_clicked_at           TEXT,
  reminder_due_at          TEXT,
  reminder_claimed_at      TEXT,
  reminder_sent_at         TEXT,
  reminder_cancelled_at    TEXT,
  reminder_attempts        INTEGER NOT NULL DEFAULT 0
                             CHECK (reminder_attempts BETWEEN 0 AND 1),
  reminder_error_code      TEXT,
  unfollowed_at            TEXT,
  completed_at             TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  PRIMARY KEY (line_account_id, friend_id, program_version),
  FOREIGN KEY (friend_id, line_account_id)
    REFERENCES friends (id, line_account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_satoyama_onboarding_due
  ON satoyama_onboarding_states (
    line_account_id,
    reminder_due_at,
    reminder_attempts,
    status
  );

CREATE TABLE IF NOT EXISTS satoyama_onboarding_answer_events (
  id                      TEXT PRIMARY KEY,
  line_account_id         TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  friend_id               TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  program_version         INTEGER NOT NULL,
  idempotency_key         TEXT NOT NULL,
  request_fingerprint     TEXT NOT NULL,
  issue_code              TEXT NOT NULL CHECK (issue_code IN (
                            'key_person', 'handoff', 'unsure_start', 'safe_rules', 'automation'
                          )),
  role_code               TEXT NOT NULL CHECK (role_code IN (
                            'owner', 'internal_lead', 'frontline', 'supporter_solo'
                          )),
  area_code               TEXT NOT NULL CHECK (area_code IN (
                            'admin', 'sales', 'hiring_training', 'content', 'undecided'
                          )),
  created_at              TEXT NOT NULL,
  UNIQUE (
    line_account_id,
    friend_id,
    program_version,
    idempotency_key
  ),
  FOREIGN KEY (friend_id, line_account_id)
    REFERENCES friends (id, line_account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_satoyama_onboarding_events_friend
  ON satoyama_onboarding_answer_events (
    line_account_id,
    friend_id,
    program_version,
    created_at
  );
