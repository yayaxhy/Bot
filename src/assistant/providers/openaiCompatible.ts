import { ASSISTANT_PARSE_SCHEMA } from '../schema.js';
import { buildAssistantSystemPrompt, buildAssistantUserPrompt } from '../prompt.js';
import type { AssistantContext, ParsedAssistantIntent } from '../types.js';

export type OpenAiCompatibleConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

function clampConfidence(value: unknown, fallback = 0.2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function normalizeAiPayload(payload: any): ParsedAssistantIntent {
  const missingSlots = Array.isArray(payload?.missingSlots)
    ? payload.missingSlots.filter((item: unknown): item is string => typeof item === 'string')
    : [];

  return {
    intent: payload?.intent ?? 'unknown',
    confidence: clampConfidence(payload?.confidence, 0.25),
    source: 'ai',
    orderReference:
      payload?.orderReferenceKind
        ? {
            kind: payload.orderReferenceKind,
            raw: typeof payload?.orderReferenceRaw === 'string' ? payload.orderReferenceRaw : null,
          }
        : null,
    workerReference:
      payload?.workerReferenceKind
        ? {
            kind: payload.workerReferenceKind,
            raw: typeof payload?.workerReferenceRaw === 'string' ? payload.workerReferenceRaw : null,
          }
        : null,
    dispatchGame:
      typeof payload?.dispatchGame === 'string' && payload.dispatchGame.trim() ? payload.dispatchGame.trim() : null,
    dispatchRank:
      typeof payload?.dispatchRank === 'string' && payload.dispatchRank.trim() ? payload.dispatchRank.trim() : null,
    genderPreference:
      typeof payload?.genderPreference === 'string' && payload.genderPreference.trim()
        ? payload.genderPreference.trim()
        : null,
    companionType:
      typeof payload?.companionType === 'string' && payload.companionType.trim() ? payload.companionType.trim() : null,
    helpTopic: typeof payload?.helpTopic === 'string' && payload.helpTopic.trim() ? payload.helpTopic.trim() : null,
    softPreferences: Array.isArray(payload?.softPreferences)
      ? payload.softPreferences.filter((item: unknown): item is string => typeof item === 'string' && !!item.trim())
      : [],
    orderContent:
      typeof payload?.orderContent === 'string' && payload.orderContent.trim() ? payload.orderContent.trim() : null,
    giftName: typeof payload?.giftName === 'string' && payload.giftName.trim() ? payload.giftName.trim() : null,
    quantity: Number.isFinite(Number(payload?.quantity)) ? Number(payload.quantity) : null,
    missingSlots,
    rationale: typeof payload?.rationale === 'string' ? payload.rationale : null,
  };
}

function buildJsonOnlyInstruction() {
  return [
    '你必须只返回一个 JSON 对象，不要输出 markdown、解释、代码块或额外文字。',
    'JSON 字段必须完整，必须包含这些键：',
    'intent, confidence, orderReferenceKind, orderReferenceRaw, workerReferenceKind, workerReferenceRaw, giftName, dispatchGame, dispatchRank, genderPreference, companionType, helpTopic, softPreferences, orderContent, quantity, missingSlots, rationale。',
    '字段未知时返回 null；数组字段没有值时返回空数组；无法确定时 intent 返回 unknown。',
  ].join('\n');
}

function extractJsonObject(rawContent: string) {
  const trimmed = rawContent.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

async function requestParse(params: {
  config: OpenAiCompatibleConfig;
  content: string;
  context: AssistantContext;
  useStructuredFormat: boolean;
}) {
  const { config, content, context, useStructuredFormat } = params;
  const messages = [
    {
      role: 'system',
      content: buildAssistantSystemPrompt(),
    },
    {
      role: 'user',
      content: buildAssistantUserPrompt({
        content,
        conversation: context.conversation,
        nowIso: new Date().toISOString(),
      }),
    },
  ];

  if (!useStructuredFormat) {
    messages.push({
      role: 'system' as const,
      content: buildJsonOnlyInstruction(),
    });
  }

  const body: Record<string, unknown> = {
    model: config.model,
    temperature: 0,
    messages,
  };

  if (useStructuredFormat) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'assistant_intent',
        strict: true,
        schema: ASSISTANT_PARSE_SCHEMA,
      },
    };
  }

  return fetch(config.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

export async function parseWithOpenAiCompatible(
  content: string,
  context: AssistantContext,
  config: OpenAiCompatibleConfig,
): Promise<ParsedAssistantIntent | null> {
  let response = await requestParse({
    config,
    content,
    context,
    useStructuredFormat: true,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const unsupportedStructuredFormat =
      response.status === 400 && body.includes('response_format type is unavailable');

    if (!unsupportedStructuredFormat) {
      throw new Error(`AI parse failed: ${response.status} ${body}`);
    }

    response = await requestParse({
      config,
      content,
      context,
      useStructuredFormat: false,
    });

    if (!response.ok) {
      const fallbackBody = await response.text().catch(() => '');
      throw new Error(`AI parse failed: ${response.status} ${fallbackBody}`);
    }
  }

  const payload = await response.json();
  const rawContent = payload?.choices?.[0]?.message?.content;
  if (typeof rawContent !== 'string' || !rawContent.trim()) {
    return null;
  }

  return normalizeAiPayload(JSON.parse(extractJsonObject(rawContent)));
}
