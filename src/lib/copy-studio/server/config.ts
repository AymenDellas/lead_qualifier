import type { ProviderConfig } from './provider';
import { AppError } from './errors';

export function providerConfig(): ProviderConfig {
  const timeoutMs = Number(process.env.COPY_STUDIO_TIMEOUT_MS || 90000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000)
    throw new AppError(503, 'COPY_STUDIO_TIMEOUT_MS must be between 1000 and 180000.');
  const baseUrl =
    process.env.COPY_STUDIO_BASE_URL ||
    process.env.AGENTROUTER_BASE_URL ||
    'https://agentrouter.org/v1';
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AppError(503, 'Check COPY_STUDIO_BASE_URL in the dashboard environment.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new AppError(503, 'COPY_STUDIO_BASE_URL must be an HTTP(S) endpoint.');
  return {
    apiKey: process.env.COPY_STUDIO_API_KEY || process.env.AGENTROUTER_API_KEY || '',
    baseUrl,
    model: process.env.COPY_STUDIO_MODEL || process.env.AGENTROUTER_MODEL || 'deepseek-v4-flash',
    timeoutMs,
  };
}

export function providerStatus() {
  const config = providerConfig();
  return {
    status: 'ok',
    configured: Boolean(config.apiKey) && !/your.*key|placeholder/i.test(config.apiKey),
    model: config.model,
    version: '2.0.0',
  };
}
