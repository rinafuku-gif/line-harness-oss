import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@line-crm/db')>();
  return {
    ...actual,
    listSatoyamaCustomers: vi.fn(),
  };
});

import { listSatoyamaCustomers } from '@line-crm/db';
import { satoyamaCustomers } from './satoyama-customers.js';

function setup() {
  const app = new Hono();
  app.route('/', satoyamaCustomers);
  return app;
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    DB: {} as D1Database,
    SATOYAMA_ONBOARDING_ENABLED: 'true',
    SATOYAMA_ONBOARDING_ACCOUNT_ID: 'account-satoyama',
    SATOYAMA_SITE_READ_TOKEN: 'dedicated-read-token',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listSatoyamaCustomers).mockResolvedValue({
    customers: [
      {
        friend_id: 'friend-1',
        display_name: '山田 太郎',
        picture_url: null,
        is_following: 1,
        friend_created_at: '2026-07-27T10:00:00.000+09:00',
        status: 'completed',
        issue_code: 'automation',
        role_code: 'owner',
        area_code: 'admin',
        questions_started_at: '2026-07-27T10:01:00.000+09:00',
        completed_at: '2026-07-27T10:02:00.000+09:00',
        cta_clicked_at: null,
        answer_updated_at: '2026-07-27T10:02:00.000+09:00',
        chat_status: 'resolved',
      },
    ],
    total: 1,
    summary: {
      total: 1,
      not_started: 0,
      started: 0,
      completed: 1,
      skipped: 0,
    },
  });
});

describe('SATOYAMA customer read API', () => {
  it('fails closed when the dedicated read token is not configured', async () => {
    const response = await setup().request(
      '/api/internal/satoyama/customers',
      { headers: { Authorization: 'Bearer dedicated-read-token' } },
      env({ SATOYAMA_SITE_READ_TOKEN: undefined }),
    );
    expect(response.status).toBe(404);
    expect(listSatoyamaCustomers).not.toHaveBeenCalled();
  });

  it('rejects missing and incorrect bearer tokens', async () => {
    const missing = await setup().request(
      '/api/internal/satoyama/customers',
      {},
      env(),
    );
    const wrong = await setup().request(
      '/api/internal/satoyama/customers',
      { headers: { Authorization: 'Bearer wrong-token' } },
      env(),
    );
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(listSatoyamaCustomers).not.toHaveBeenCalled();
  });

  it('returns only sanitized customer fields and friendly labels', async () => {
    const response = await setup().request(
      '/api/internal/satoyama/customers?status=completed&limit=20',
      { headers: { Authorization: 'Bearer dedicated-read-token' } },
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await response.json() as {
      data: { customers: Array<Record<string, unknown>> };
    };
    expect(body.data.customers[0]).toMatchObject({
      friendId: 'friend-1',
      displayName: '山田 太郎',
      status: 'completed',
      issue: { code: 'automation', label: '具体的な業務を自動化・仕組み化したい' },
      role: { code: 'owner', label: '経営者・代表' },
      area: { code: 'admin', label: '事務・管理業務' },
    });
    expect(body.data.customers[0]).not.toHaveProperty('lineUserId');
    expect(listSatoyamaCustomers).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        lineAccountId: 'account-satoyama',
        status: 'completed',
        limit: 20,
      }),
    );
  });

  it('rejects unknown filters and excessive page sizes', async () => {
    const invalidStatus = await setup().request(
      '/api/internal/satoyama/customers?status=unknown',
      { headers: { Authorization: 'Bearer dedicated-read-token' } },
      env(),
    );
    const invalidLimit = await setup().request(
      '/api/internal/satoyama/customers?limit=1000',
      { headers: { Authorization: 'Bearer dedicated-read-token' } },
      env(),
    );
    expect(invalidStatus.status).toBe(400);
    expect(invalidLimit.status).toBe(400);
  });
});
