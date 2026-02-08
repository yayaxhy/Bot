import { Prisma, PrismaClient, ScratchPrizeType, ScratchTicketStatus } from '@prisma/client';
import prisma from '../db/prisma.js';
import { splitIncomeRecharge } from '../lib/balanceMath.js';
import { recordIndividualTransaction } from './individualTransactionService.js';

const DEC = (value: Prisma.Decimal | number | string) =>
  value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);

const SCRATCH_SEED_LOCK_KEY = 180208601;
const SCRATCH_DEFAULT_TOTAL_TICKETS = 1000;
const SCRATCH_THANKS_TO_UNLOCK_P200_DEFAULT = 10;
export const SCRATCH_TICKET_PRICE = new Prisma.Decimal(29);
export const SCRATCH_SYSTEM_ID = process.env.SCRATCH_SYSTEM_ID ?? 'scratch-system';
let scratchRandomThanksCount = 0;
let scratchPityLock: Promise<void> = Promise.resolve();

type PrizeConfig = {
  type: ScratchPrizeType;
  amount: Prisma.Decimal;
  probability: number;
  label: string;
};

const PRIZE_CONFIGS: PrizeConfig[] = [
  {
    type: ScratchPrizeType.THANKS,
    amount: DEC(0),
    probability: 0.23,
    label: '谢谢惠顾',
  },
  {
    type: ScratchPrizeType.P5,
    amount: DEC(5),
    probability: 0.23,
    label: '5',
  },
  {
    type: ScratchPrizeType.P20,
    amount: DEC(20),
    probability: 0.22,
    label: '20',
  },
  {
    type: ScratchPrizeType.P30,
    amount: DEC(30),
    probability: 0.18,
    label: '30',
  },
  {
    type: ScratchPrizeType.P50,
    amount: DEC(50),
    probability: 0.09,
    label: '50',
  },
  {
    type: ScratchPrizeType.P99,
    amount: DEC(99),
    probability: 0.04,
    label: '99',
  },
  {
    type: ScratchPrizeType.P200,
    amount: DEC(200),
    probability: 0.01,
    label: '200',
  },
];

const PRIZE_CONFIG_BY_TYPE = new Map<ScratchPrizeType, PrizeConfig>(
  PRIZE_CONFIGS.map((item) => [item.type, item] as const),
);

export type ScratchInventoryPage = {
  total: number;
  sold: number;
  unsold: number;
  totalPages: number;
  page: number;
  pageSize: number;
  codes: string[];
};

export type ScratchPurchaseResult =
  | { status: 'ok'; ticket: PurchasedTicket; purchaseAmount: Prisma.Decimal }
  | { status: 'insufficient' }
  | { status: 'sold_out' }
  | { status: 'code_not_found' }
  | { status: 'code_sold' };

export type ScratchRevealResult =
  | { status: 'ok'; ticket: RevealedTicket; rewardAmount: Prisma.Decimal }
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'already_revealed'; ticket: RevealedTicket };

export type PurchasedTicket = {
  id: string;
  code: string;
  serialNo: number;
  prizeType: ScratchPrizeType;
};

export type RevealedTicket = {
  id: string;
  code: string;
  serialNo: number;
  prizeType: ScratchPrizeType;
  prizeAmount: Prisma.Decimal;
  status: ScratchTicketStatus;
};

const CODE_RE = /^G(\d{1,6})$/i;

function parseTicketCountFromEnv() {
  const raw = process.env.SCRATCH_TICKET_COUNT;
  if (!raw) return SCRATCH_DEFAULT_TOTAL_TICKETS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return SCRATCH_DEFAULT_TOTAL_TICKETS;
  return parsed;
}

function parseThanksToUnlockP200() {
  const raw = process.env.SCRATCH_THANKS_TO_UNLOCK_P200;
  if (!raw) return SCRATCH_THANKS_TO_UNLOCK_P200_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return SCRATCH_THANKS_TO_UNLOCK_P200_DEFAULT;
  return parsed;
}

async function withScratchPityLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = scratchPityLock.then(fn, fn);
  scratchPityLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function shuffle<T>(arr: T[]) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function buildPrizeDeck(totalCount: number) {
  const sum = PRIZE_CONFIGS.reduce((acc, item) => acc + item.probability, 0);
  if (Math.abs(sum - 1) > 1e-8) {
    throw new Error(`scratch_prize_probability_invalid:${sum}`);
  }

  const entries = PRIZE_CONFIGS.map((item) => {
    const exact = totalCount * item.probability;
    const floor = Math.floor(exact);
    return {
      item,
      exact,
      count: floor,
      frac: exact - floor,
    };
  });

  let used = entries.reduce((acc, row) => acc + row.count, 0);
  if (used < totalCount) {
    entries
      .slice()
      .sort((a, b) => b.frac - a.frac)
      .slice(0, totalCount - used)
      .forEach((row) => {
        row.count += 1;
      });
    used = entries.reduce((acc, row) => acc + row.count, 0);
  }
  if (used > totalCount) {
    entries
      .slice()
      .sort((a, b) => a.frac - b.frac)
      .slice(0, used - totalCount)
      .forEach((row) => {
        row.count -= 1;
      });
  }

  const deck: ScratchPrizeType[] = [];
  for (const row of entries) {
    for (let i = 0; i < row.count; i += 1) {
      deck.push(row.item.type);
    }
  }
  if (deck.length !== totalCount) {
    throw new Error(`scratch_deck_size_invalid:${deck.length}/${totalCount}`);
  }
  shuffle(deck);
  return deck;
}

function normalizeScratchCode(serial: number) {
  return `G${serial.toString().padStart(3, '0')}`;
}

export function parseScratchCode(input: string | null | undefined) {
  if (!input) return null;
  const text = input.trim().toUpperCase();
  const match = text.match(CODE_RE);
  if (!match) return null;
  const serial = Number.parseInt(match[1], 10);
  if (!Number.isInteger(serial) || serial <= 0) return null;
  return normalizeScratchCode(serial);
}

export function getScratchPrizeLabel(type: ScratchPrizeType) {
  if (type === ScratchPrizeType.P10) return '10';
  if (type === ScratchPrizeType.P52) return '52';
  if (type === ScratchPrizeType.P100) return '100';
  if (type === ScratchPrizeType.P150) return '150';
  return PRIZE_CONFIG_BY_TYPE.get(type)?.label ?? type;
}

async function updatePeiwanBalance(
  tx: Prisma.TransactionClient,
  userId: string,
  newBalance: Prisma.Decimal,
) {
  const peiwan = await tx.pEIWAN.findUnique({
    where: { discordUserId: userId },
    select: { PEIWANID: true },
  });
  if (!peiwan) return;
  await tx.pEIWAN.update({
    where: { discordUserId: userId },
    data: { balance: newBalance },
  });
}

async function ensureScratchPoolSeededTx(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SCRATCH_SEED_LOCK_KEY})`;
  const count = await tx.scratchTicket.count();
  if (count > 0) return;

  const total = parseTicketCountFromEnv();
  const deck = buildPrizeDeck(total);
  const now = new Date();

  await tx.scratchTicket.createMany({
    data: deck.map((type, idx) => {
      const cfg = PRIZE_CONFIG_BY_TYPE.get(type)!;
      return {
        serialNo: idx + 1,
        code: normalizeScratchCode(idx + 1),
        status: ScratchTicketStatus.UNSOLD,
        prizeType: type,
        prizeAmount: cfg.amount,
        createdAt: now,
        updatedAt: now,
      };
    }),
  });
}

export async function ensureScratchPoolSeeded() {
  await prisma.$transaction(async (tx) => {
    await ensureScratchPoolSeededTx(tx);
  });
}

type PurchaseParams = {
  userId: string;
  ownerId?: string | null;
  requestedCode?: string | null;
  counterpartyId?: string;
};

export async function purchaseScratchTicket(params: PurchaseParams): Promise<ScratchPurchaseResult> {
  const requestedCode = params.requestedCode?.trim().toUpperCase() ?? null;
  const ticketOwnerId = params.ownerId?.trim() || params.userId;
  const isRandomPick = !requestedCode;
  const thanksToUnlockP200 = parseThanksToUnlockP200();

  const run = async (): Promise<ScratchPurchaseResult> => {
    const canRollP200 = !isRandomPick || scratchRandomThanksCount >= thanksToUnlockP200;
    const result = await prisma.$transaction(async (tx) => {
    await ensureScratchPoolSeededTx(tx);

    if (requestedCode) {
      const wanted = await tx.scratchTicket.findUnique({
        where: { code: requestedCode },
        select: { status: true },
      });
      if (!wanted) return { status: 'code_not_found' as const };
      if (wanted.status !== ScratchTicketStatus.UNSOLD) return { status: 'code_sold' as const };
    }

    await tx.member.upsert({
      where: { discordUserId: params.userId },
      create: { discordUserId: params.userId },
      update: {},
    });
    if (ticketOwnerId !== params.userId) {
      await tx.member.upsert({
        where: { discordUserId: ticketOwnerId },
        create: { discordUserId: ticketOwnerId },
        update: {},
      });
    }

    const member = await tx.member.findUnique({
      where: { discordUserId: params.userId },
      select: { income: true, recharge: true, totalBalance: true },
    });
    if (!member) return { status: 'insufficient' as const };

    let incomePool = DEC(member.income ?? 0);
    let rechargePool = DEC(member.recharge ?? 0);
    const totalBalance = DEC(member.totalBalance ?? 0);
    const knownPool = incomePool.add(rechargePool);
    const maxAvailable = knownPool.gt(totalBalance) ? knownPool : totalBalance;
    if (maxAvailable.lt(SCRATCH_TICKET_PRICE)) {
      return { status: 'insufficient' as const };
    }
    if (knownPool.lt(SCRATCH_TICKET_PRICE)) {
      const missing = SCRATCH_TICKET_PRICE.sub(knownPool);
      const extra = totalBalance.sub(knownPool);
      if (extra.lt(missing)) {
        return { status: 'insufficient' as const };
      }
      rechargePool = rechargePool.add(missing);
    }

    let ticketId: string | null = null;

    if (requestedCode) {
      const updated = await tx.scratchTicket.updateMany({
        where: { code: requestedCode, status: ScratchTicketStatus.UNSOLD },
        data: {
          status: ScratchTicketStatus.SOLD,
          ownerId: ticketOwnerId,
        },
      });
      if (updated.count === 0) return { status: 'code_sold' as const };
      const ticket = await tx.scratchTicket.findUnique({
        where: { code: requestedCode },
        select: { id: true },
      });
      if (!ticket) return { status: 'code_not_found' as const };
      ticketId = ticket.id;
    } else {
      const p200Filter = canRollP200 ? Prisma.empty : Prisma.sql`AND "prizeType" <> 'P200'`;
      const rows = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id"
                   FROM "ScratchTicket"
                   WHERE "status" = 'UNSOLD'
                   ${p200Filter}
                   ORDER BY random()
                   LIMIT 1
                   FOR UPDATE SKIP LOCKED`,
      );
      if (!rows.length) return { status: 'sold_out' as const };
      const candidateId = rows[0].id;
      const updated = await tx.scratchTicket.updateMany({
        where: { id: candidateId, status: ScratchTicketStatus.UNSOLD },
        data: {
          status: ScratchTicketStatus.SOLD,
          ownerId: ticketOwnerId,
        },
      });
      if (updated.count === 0) return { status: 'sold_out' as const };
      ticketId = candidateId;
    }

    const split = splitIncomeRecharge(incomePool, rechargePool, SCRATCH_TICKET_PRICE);
    await tx.member.update({
      where: { discordUserId: params.userId },
      data: {
        income: split.incomeAfter,
        recharge: split.rechargeAfter,
        totalBalance: split.totalAfter,
        totalSpent: { increment: SCRATCH_TICKET_PRICE },
      },
    });
    await updatePeiwanBalance(tx, params.userId, split.totalAfter);

    await recordIndividualTransaction(tx, {
      discordId: params.userId,
      thirdPartydiscordId: params.counterpartyId ?? SCRATCH_SYSTEM_ID,
      balanceBefore: split.totalBefore,
      amountChange: SCRATCH_TICKET_PRICE,
      balanceAfter: split.totalAfter,
      typeOfTransaction: '刮刮乐购卡',
    });

    const ticket = await tx.scratchTicket.update({
      where: { id: ticketId! },
      data: {},
      select: {
        id: true,
        code: true,
        serialNo: true,
        prizeType: true,
      },
    });

    return { status: 'ok' as const, ticket, purchaseAmount: SCRATCH_TICKET_PRICE };
    });

    if (isRandomPick && result.status === 'ok') {
      if (result.ticket.prizeType === ScratchPrizeType.THANKS) {
        scratchRandomThanksCount += 1;
      } else if (result.ticket.prizeType === ScratchPrizeType.P200) {
        scratchRandomThanksCount = 0;
      }
    }

    return result;
  };

  return isRandomPick ? withScratchPityLock(run) : run();
}

type RevealParams = {
  ticketId: string;
  userId: string;
  revealMessageId?: string | null;
  counterpartyId?: string;
};

export async function revealScratchTicket(params: RevealParams): Promise<ScratchRevealResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "ScratchTicket" WHERE id = ${params.ticketId} FOR UPDATE`;
    const current = await tx.scratchTicket.findUnique({
      where: { id: params.ticketId },
      select: {
        id: true,
        code: true,
        serialNo: true,
        status: true,
        ownerId: true,
        prizeType: true,
        prizeAmount: true,
      },
    });

    if (!current) return { status: 'not_found' as const };
    if (current.ownerId !== params.userId) return { status: 'forbidden' as const };

    if (current.status === ScratchTicketStatus.REVEALED) {
      return {
        status: 'already_revealed' as const,
        ticket: {
          id: current.id,
          code: current.code,
          serialNo: current.serialNo,
          prizeType: current.prizeType,
          prizeAmount: current.prizeAmount,
          status: current.status,
        },
      };
    }

    if (current.status !== ScratchTicketStatus.SOLD) {
      return { status: 'not_found' as const };
    }

    const reward = DEC(current.prizeAmount ?? 0);
    if (reward.gt(0)) {
      await tx.member.upsert({
        where: { discordUserId: params.userId },
        create: { discordUserId: params.userId },
        update: {},
      });
      const member = await tx.member.findUnique({
        where: { discordUserId: params.userId },
        select: { totalBalance: true },
      });
      const before = DEC(member?.totalBalance ?? 0);
      const after = before.add(reward);

      await tx.member.update({
        where: { discordUserId: params.userId },
        data: {
          recharge: { increment: reward },
          totalBalance: { increment: reward },
        },
      });
      await updatePeiwanBalance(tx, params.userId, after);

      await recordIndividualTransaction(tx, {
        discordId: params.userId,
        thirdPartydiscordId: params.counterpartyId ?? SCRATCH_SYSTEM_ID,
        balanceBefore: before,
        amountChange: reward,
        balanceAfter: after,
        typeOfTransaction: '刮刮乐中奖',
      });
    }

    const updated = await tx.scratchTicket.update({
      where: { id: params.ticketId },
      data: {
        status: ScratchTicketStatus.REVEALED,
        revealedAt: new Date(),
        revealMessageId: params.revealMessageId ?? undefined,
      },
      select: {
        id: true,
        code: true,
        serialNo: true,
        prizeType: true,
        prizeAmount: true,
        status: true,
      },
    });

    return {
      status: 'ok' as const,
      ticket: {
        ...updated,
      },
      rewardAmount: reward,
    };
  });
}

export async function getScratchInventory(page = 1, pageSize = 50): Promise<ScratchInventoryPage> {
  await ensureScratchPoolSeeded();

  const safePageSize = Math.max(1, Math.min(200, Math.trunc(pageSize)));
  const safePage = Math.max(1, Math.trunc(page));

  const [total, unsold, codes] = await Promise.all([
    prisma.scratchTicket.count(),
    prisma.scratchTicket.count({ where: { status: ScratchTicketStatus.UNSOLD } }),
    prisma.scratchTicket.findMany({
      where: { status: ScratchTicketStatus.UNSOLD },
      orderBy: { serialNo: 'asc' },
      skip: (safePage - 1) * safePageSize,
      take: safePageSize,
      select: { code: true },
    }),
  ]);

  const sold = total - unsold;
  const totalPages = Math.max(1, Math.ceil(unsold / safePageSize));
  const normalizedPage = Math.min(safePage, totalPages);

  let pageCodes = codes.map((x) => x.code);
  if (normalizedPage !== safePage) {
    const rows = await prisma.scratchTicket.findMany({
      where: { status: ScratchTicketStatus.UNSOLD },
      orderBy: { serialNo: 'asc' },
      skip: (normalizedPage - 1) * safePageSize,
      take: safePageSize,
      select: { code: true },
    });
    pageCodes = rows.map((x) => x.code);
  }

  return {
    total,
    sold,
    unsold,
    totalPages,
    page: normalizedPage,
    pageSize: safePageSize,
    codes: pageCodes,
  };
}
