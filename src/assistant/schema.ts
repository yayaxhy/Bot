export const ASSISTANT_PARSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'intent',
    'confidence',
    'orderReferenceKind',
    'orderReferenceRaw',
    'workerReferenceKind',
    'workerReferenceRaw',
    'giftName',
    'dispatchGame',
    'dispatchRank',
    'genderPreference',
    'companionType',
    'helpTopic',
    'softPreferences',
    'orderContent',
    'quantity',
    'missingSlots',
    'rationale',
  ],
  properties: {
    intent: {
      type: 'string',
      enum: [
        'invite.accept',
        'invite.decline',
        'dispatch.create',
        'order.create',
        'order.end',
        'gift.send',
        'balance.query',
        'worker.id.query',
        'help.query',
        'unknown',
      ],
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
    orderReferenceKind: {
      type: ['string', 'null'],
      enum: [
        'latest_running_order',
        'latest_pending_invitation',
        'latest_order',
        'previous_order',
        'explicit_display_no',
        'explicit_id',
        null,
      ],
    },
    orderReferenceRaw: {
      type: ['string', 'null'],
    },
    workerReferenceKind: {
      type: ['string', 'null'],
      enum: [
        'current_order_worker',
        'last_worker',
        'yesterday_worker',
        'explicit_discord_user_id',
        'explicit_peiwan_id',
        'memory_worker',
        null,
      ],
    },
    workerReferenceRaw: {
      type: ['string', 'null'],
    },
    giftName: {
      type: ['string', 'null'],
    },
    dispatchGame: {
      type: ['string', 'null'],
    },
    dispatchRank: {
      type: ['string', 'null'],
    },
    genderPreference: {
      type: ['string', 'null'],
    },
    companionType: {
      type: ['string', 'null'],
    },
    helpTopic: {
      type: ['string', 'null'],
    },
    softPreferences: {
      type: 'array',
      items: { type: 'string' },
    },
    orderContent: {
      type: ['string', 'null'],
    },
    quantity: {
      type: ['number', 'null'],
      minimum: 1,
    },
    missingSlots: {
      type: 'array',
      items: { type: 'string' },
    },
    rationale: {
      type: ['string', 'null'],
    },
  },
} as const;
