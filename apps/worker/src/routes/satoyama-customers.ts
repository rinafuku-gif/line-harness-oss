import { Hono, type Context } from 'hono';
import {
  listSatoyamaCustomers,
  type SatoyamaCustomerAnswerStatus,
} from '@line-crm/db';
import type { Env } from '../index.js';
import {
  AREA_OPTIONS,
  ISSUE_OPTIONS,
  ROLE_OPTIONS,
  isSatoyamaAreaCode,
  isSatoyamaIssueCode,
  isSatoyamaRoleCode,
} from '../features/satoyama-onboarding/content.js';
import { configuredSatoyamaAccountId } from '../services/satoyama-onboarding-reminder.js';

const satoyamaCustomers = new Hono<Env>();
const STATUSES = new Set<SatoyamaCustomerAnswerStatus>([
  'not_started',
  'started',
  'completed',
  'skipped',
]);

function bearerToken(c: Context<Env>): string | null {
  const value = c.req.header('Authorization');
  if (!value?.startsWith('Bearer ')) return null;
  const token = value.slice('Bearer '.length).trim();
  return token || null;
}

function secretsMatch(expected: string, provided: string): boolean {
  const encoder = new TextEncoder();
  const expectedBytes = encoder.encode(expected);
  const providedBytes = encoder.encode(provided);
  // Dedicated tokens are intentionally short. A fixed loop avoids making the
  // comparison duration depend on how many leading bytes happened to match.
  if (expectedBytes.length > 256 || providedBytes.length > 256) {
    return false;
  }
  let difference = expectedBytes.length ^ providedBytes.length;
  for (let index = 0; index < 256; index += 1) {
    difference |= (expectedBytes[index] ?? 0) ^ (providedBytes[index] ?? 0);
  }
  return difference === 0;
}

function labelFor<T extends string>(
  options: readonly { code: T; label: string }[],
  code: T | null,
): string | null {
  return code ? options.find((option) => option.code === code)?.label ?? null : null;
}

satoyamaCustomers.get('/api/internal/satoyama/customers', async (c) => {
  const expectedToken = c.env.SATOYAMA_SITE_READ_TOKEN;
  const accountId = configuredSatoyamaAccountId(c.env);
  if (!expectedToken || !accountId) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }

  const providedToken = bearerToken(c);
  if (!providedToken || !secretsMatch(expectedToken, providedToken)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const rawStatus = c.req.query('status');
  const rawIssue = c.req.query('issue');
  const rawRole = c.req.query('role');
  const rawArea = c.req.query('area');
  const status =
    rawStatus && STATUSES.has(rawStatus as SatoyamaCustomerAnswerStatus)
      ? (rawStatus as SatoyamaCustomerAnswerStatus)
      : undefined;
  if (rawStatus && !status) {
    return c.json({ success: false, error: 'Invalid status' }, 400);
  }
  if (rawIssue && !isSatoyamaIssueCode(rawIssue)) {
    return c.json({ success: false, error: 'Invalid issue' }, 400);
  }
  if (rawRole && !isSatoyamaRoleCode(rawRole)) {
    return c.json({ success: false, error: 'Invalid role' }, 400);
  }
  if (rawArea && !isSatoyamaAreaCode(rawArea)) {
    return c.json({ success: false, error: 'Invalid area' }, 400);
  }
  const issue = rawIssue && isSatoyamaIssueCode(rawIssue) ? rawIssue : undefined;
  const role = rawRole && isSatoyamaRoleCode(rawRole) ? rawRole : undefined;
  const area = rawArea && isSatoyamaAreaCode(rawArea) ? rawArea : undefined;

  const rawLimit = Number(c.req.query('limit') ?? '50');
  const rawOffset = Number(c.req.query('offset') ?? '0');
  if (
    !Number.isInteger(rawLimit) ||
    rawLimit < 1 ||
    rawLimit > 100 ||
    !Number.isInteger(rawOffset) ||
    rawOffset < 0
  ) {
    return c.json({ success: false, error: 'Invalid pagination' }, 400);
  }

  try {
    const result = await listSatoyamaCustomers(c.env.DB, {
      lineAccountId: accountId,
      search: c.req.query('search'),
      status,
      issue,
      role,
      area,
      limit: rawLimit,
      offset: rawOffset,
    });
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      success: true,
      data: {
        ...result,
        customers: result.customers.map((customer) => ({
          friendId: customer.friend_id,
          displayName: customer.display_name,
          pictureUrl: customer.picture_url,
          isFollowing: Boolean(customer.is_following),
          friendCreatedAt: customer.friend_created_at,
          status: customer.status,
          issue: customer.issue_code
            ? {
                code: customer.issue_code,
                label: labelFor(ISSUE_OPTIONS, customer.issue_code),
              }
            : null,
          role: customer.role_code
            ? {
                code: customer.role_code,
                label: labelFor(ROLE_OPTIONS, customer.role_code),
              }
            : null,
          area: customer.area_code
            ? {
                code: customer.area_code,
                label: labelFor(AREA_OPTIONS, customer.area_code),
              }
            : null,
          questionsStartedAt: customer.questions_started_at,
          completedAt: customer.completed_at,
          ctaClickedAt: customer.cta_clicked_at,
          answerUpdatedAt: customer.answer_updated_at,
          chatStatus: customer.chat_status,
        })),
      },
    });
  } catch {
    console.error('[satoyama-customers] list failed');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { satoyamaCustomers };
