import type { AssistantContext, ParsedAssistantIntent } from '../types.js';
import { parseWithOpenAiCompatible } from './openaiCompatible.js';

type AssistantProvider = 'disabled' | 'openai-compatible';

function resolveProvider(): AssistantProvider {
  const raw = (process.env.ASSISTANT_PROVIDER ?? 'openai-compatible').trim().toLowerCase();
  if (raw === 'disabled' || raw === 'none' || raw === 'off') return 'disabled';
  return 'openai-compatible';
}

function resolveCompatibleConfig() {
  const apiKey = (
    process.env.ASSISTANT_API_KEY
    ?? process.env.OPENAI_API_KEY
    ?? ''
  ).trim();
  const baseUrl = (
    process.env.ASSISTANT_BASE_URL
    ?? process.env.ASSISTANT_OPENAI_BASE_URL
    ?? 'https://api.openai.com/v1/chat/completions'
  ).trim();
  const model = (
    process.env.ASSISTANT_MODEL
    ?? process.env.ASSISTANT_OPENAI_MODEL
    ?? 'gpt-5-mini'
  ).trim();

  if (!apiKey) return null;
  return { apiKey, baseUrl, model };
}

export function getAssistantProviderStatus() {
  const provider = resolveProvider();
  const config = resolveCompatibleConfig();
  return {
    enabled: provider !== 'disabled' && !!config,
    provider,
    baseUrl: config?.baseUrl ?? null,
    model: config?.model ?? null,
    hasApiKey: !!config?.apiKey,
    tokenSavingMode: 'rules-first-ai-fallback',
  } as const;
}

export async function parseWithConfiguredProvider(
  content: string,
  context: AssistantContext,
): Promise<ParsedAssistantIntent | null> {
  const provider = resolveProvider();
  if (provider === 'disabled') return null;

  const config = resolveCompatibleConfig();
  if (!config) return null;

  return parseWithOpenAiCompatible(content, context, config);
}
