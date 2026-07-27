import {
  claimSatoyamaOnboardingReminder,
  getDueSatoyamaOnboardingReminders,
  getSatoyamaOnboardingState,
  markSatoyamaOnboardingFollowState,
  markSatoyamaOnboardingReminderResult,
  scheduleSatoyamaOnboardingReminder,
  toJstString,
} from '@line-crm/db';
import { LineClient, type Message } from '@line-crm/line-sdk';

const REMINDER_DELAY_MS = 48 * 60 * 60 * 1000;

export interface SatoyamaOnboardingRuntimeConfig {
  SATOYAMA_ONBOARDING_ENABLED?: string;
  SATOYAMA_ONBOARDING_ACCOUNT_ID?: string;
  SATOYAMA_ONBOARDING_REMINDER_ENABLED?: string;
}

export function configuredSatoyamaAccountId(
  env: SatoyamaOnboardingRuntimeConfig,
): string | null {
  if (env.SATOYAMA_ONBOARDING_ENABLED !== 'true') return null;
  const accountId = env.SATOYAMA_ONBOARDING_ACCOUNT_ID?.trim();
  return accountId || null;
}

export async function scheduleFriendOnboardingReminder(
  db: D1Database,
  input: {
    lineAccountId: string | null;
    friendId: string;
    env: SatoyamaOnboardingRuntimeConfig;
    now?: Date;
  },
): Promise<void> {
  const configuredAccountId = configuredSatoyamaAccountId(input.env);
  if (!configuredAccountId) return;
  if (input.lineAccountId !== configuredAccountId) return;

  const now = input.now ?? new Date();
  await markSatoyamaOnboardingFollowState(db, {
    lineAccountId: configuredAccountId,
    friendId: input.friendId,
    isFollowing: true,
    now: toJstString(now),
  });
  if (input.env.SATOYAMA_ONBOARDING_REMINDER_ENABLED !== 'true') return;

  await scheduleSatoyamaOnboardingReminder(db, {
    lineAccountId: configuredAccountId,
    friendId: input.friendId,
    now: toJstString(now),
    dueAt: toJstString(new Date(now.getTime() + REMINDER_DELAY_MS)),
  });
}

export async function cancelFriendOnboardingReminder(
  db: D1Database,
  input: {
    lineAccountId: string | null;
    friendId: string;
    env: SatoyamaOnboardingRuntimeConfig;
    now?: Date;
  },
): Promise<void> {
  const configuredAccountId = configuredSatoyamaAccountId(input.env);
  if (!configuredAccountId || input.lineAccountId !== configuredAccountId) return;
  await markSatoyamaOnboardingFollowState(db, {
    lineAccountId: configuredAccountId,
    friendId: input.friendId,
    isFollowing: false,
    now: toJstString(input.now ?? new Date()),
  });
}

export function buildSatoyamaOnboardingLiffUrl(liffId: string): string {
  const encoded = encodeURIComponent(liffId);
  return `https://liff.line.me/${encoded}/onboarding/satoyama?liffId=${encoded}`;
}

function reminderMessage(liffId: string): Message {
  return {
    type: 'text',
    text:
      'よければ、いまの状況に合う進め方を3問で整理できます。回答は任意で、答えなくてもAI相談やメニューはそのまま使えます。\n\n' +
      buildSatoyamaOnboardingLiffUrl(liffId),
  };
}

export async function processSatoyamaOnboardingReminders(
  db: D1Database,
  input: {
    env: SatoyamaOnboardingRuntimeConfig;
    now?: Date;
    limit?: number;
  },
): Promise<{ attempted: number; sent: number; failed: number; skipped: number }> {
  const accountId = configuredSatoyamaAccountId(input.env);
  if (!accountId || input.env.SATOYAMA_ONBOARDING_REMINDER_ENABLED !== 'true') {
    return { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  }

  const now = toJstString(input.now ?? new Date());
  const due = await getDueSatoyamaOnboardingReminders(db, {
    lineAccountId: accountId,
    now,
    limit: input.limit,
  });
  let attempted = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of due) {
    const claimed = await claimSatoyamaOnboardingReminder(db, {
      lineAccountId: row.line_account_id,
      friendId: row.friend_id,
      now,
    });
    if (!claimed) {
      skipped++;
      continue;
    }
    attempted++;

    // Completion/skip can race with the due query. Re-read immediately before
    // the external call and do not send when the user has already answered.
    const latest = await getSatoyamaOnboardingState(db, row.line_account_id, row.friend_id);
    if (
      !latest ||
      !['pending', 'started'].includes(latest.status) ||
      latest.reminder_cancelled_at ||
      latest.reminder_sent_at
    ) {
      skipped++;
      continue;
    }

    try {
      const client = new LineClient(row.channel_access_token);
      await client.pushMessage(row.line_user_id, [reminderMessage(row.liff_id)]);
      await markSatoyamaOnboardingReminderResult(db, {
        lineAccountId: row.line_account_id,
        friendId: row.friend_id,
        now,
        sent: true,
      });
      sent++;
    } catch {
      // Do not store exception text: provider errors can contain identifiers.
      // A failed attempt is not retried because this reminder must run at most once.
      await markSatoyamaOnboardingReminderResult(db, {
        lineAccountId: row.line_account_id,
        friendId: row.friend_id,
        now,
        sent: false,
      });
      failed++;
    }
  }

  return { attempted, sent, failed, skipped };
}
