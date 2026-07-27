const DEFAULT_BASE_URL = 'https://line.satoyama-ai-base.com';
const DEFAULT_LIFF_ID = '2010452980-ng2A6Rna';

export interface ProductionCanaryResult {
  pageStatus: number;
  apiStatus: number;
}

function assertHttpsBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error('Production canary requires an HTTPS base URL');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

function assertLiffId(value: string): string {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(value)) {
    throw new Error('Invalid LIFF ID');
  }
  return value;
}

export async function runSatoyamaOnboardingProductionCanary(
  options: {
    baseUrl?: string;
    liffId?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ProductionCanaryResult> {
  const base = assertHttpsBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const liffId = assertLiffId(options.liffId ?? DEFAULT_LIFF_ID);
  const fetchImpl = options.fetchImpl ?? fetch;

  const pageUrl = new URL('/onboarding/satoyama', base);
  pageUrl.searchParams.set('liffId', liffId);
  const pageResponse = await fetchImpl(pageUrl, {
    method: 'GET',
    redirect: 'manual',
    headers: { accept: 'text/html' },
  });
  if (pageResponse.status !== 200) {
    throw new Error(`Onboarding page returned ${pageResponse.status}`);
  }
  const contentType = pageResponse.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    throw new Error(`Onboarding page returned unexpected content type: ${contentType}`);
  }

  const apiUrl = new URL('/api/liff/onboarding/satoyama', base);
  apiUrl.searchParams.set('liffId', liffId);
  const apiResponse = await fetchImpl(apiUrl, {
    method: 'GET',
    redirect: 'manual',
    headers: { accept: 'application/json' },
  });
  if (apiResponse.status !== 401) {
    throw new Error(
      `Unauthenticated onboarding API must fail closed with 401; received ${apiResponse.status}`,
    );
  }

  return {
    pageStatus: pageResponse.status,
    apiStatus: apiResponse.status,
  };
}

async function main(): Promise<void> {
  const result = await runSatoyamaOnboardingProductionCanary({
    baseUrl: process.env.SATOYAMA_LINE_BASE_URL,
    liffId: process.env.SATOYAMA_LIFF_ID,
  });
  console.log(
    `SATOYAMA onboarding production read-only canary passed: page=${result.pageStatus}, unauthenticatedApi=${result.apiStatus}`,
  );
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
