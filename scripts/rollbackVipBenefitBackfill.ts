import pg from 'pg';

const DEFAULT_START = '2026-04-16T11:22:41.929Z';
const DEFAULT_END = '2026-04-17T04:19:40.962Z';

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseIsoDate(value: string, label: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

async function main() {
  const connectionString = requireEnv('DATABASE_URL');
  const windowStart = parseIsoDate(process.env.ROLLBACK_START ?? DEFAULT_START, 'ROLLBACK_START');
  const windowEnd = parseIsoDate(process.env.ROLLBACK_END ?? DEFAULT_END, 'ROLLBACK_END');
  const dryRun = process.env.DRY_RUN !== '0';

  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    const summary = await client.query(
      `
        SELECT
          COUNT(*)::int AS benefit_instances,
          COUNT(DISTINCT g."discordUserId")::int AS users,
          COALESCE(SUM(CASE WHEN i."deliveryKind" = 'POINTS' THEN i."pointsAmount" ELSE 0 END), 0) AS total_points,
          SUM(CASE WHEN i."deliveryKind" = 'COUPON' AND i.status = 'ACTIVE' THEN 1 ELSE 0 END)::int AS active_coupon_instances,
          SUM(CASE WHEN i."deliveryKind" = 'LOTTERY' AND i.status = 'ACTIVE' THEN 1 ELSE 0 END)::int AS active_lottery_instances
        FROM "VipBenefitGrant" g
        JOIN "VipBenefitGrantInstance" i ON i."grantId" = g.id
        WHERE i."grantedAt" >= $1 AND i."grantedAt" <= $2
      `,
      [windowStart, windowEnd],
    );
    console.log('Rollback window summary');
    console.table(summary.rows);

    const usedRewards = await client.query(
      `
        SELECT
          g."discordUserId",
          ju."discordDisplayName",
          g."vipLevel",
          g."benefitCode",
          g."benefitLabel",
          c.id AS coupon_id,
          c.type AS coupon_type,
          c."consumedAt"
        FROM "VipBenefitGrant" g
        JOIN "VipBenefitGrantInstance" i ON i."grantId" = g.id
        JOIN "Coupon" c ON c.id = i."sourceCouponId"
        LEFT JOIN "JinleeUser" ju ON ju."discordUserId" = g."discordUserId"
        WHERE i."grantedAt" >= $1
          AND i."grantedAt" <= $2
          AND c.status = 'USED'
        ORDER BY c."consumedAt" DESC
      `,
      [windowStart, windowEnd],
    );
    console.log('Used rewards left untouched');
    console.table(usedRewards.rows);

    if (dryRun) {
      console.log('DRY_RUN enabled, no changes applied.');
      return;
    }

    await client.query('BEGIN');

    const expiredCoupons = await client.query(
      `
        WITH target AS (
          SELECT DISTINCT i."sourceCouponId" AS id
          FROM "VipBenefitGrantInstance" i
          WHERE i."grantedAt" >= $1
            AND i."grantedAt" <= $2
            AND i."deliveryKind" = 'COUPON'
            AND i.status = 'ACTIVE'
            AND i."sourceCouponId" IS NOT NULL
        )
        UPDATE "Coupon" c
        SET status = 'EXPIRED',
            "expiresAt" = NOW()
        FROM target
        WHERE c.id = target.id
          AND c.status = 'ACTIVE'
        RETURNING c.id
      `,
      [windowStart, windowEnd],
    );

    const expiredLotteryDraws = await client.query(
      `
        WITH target AS (
          SELECT DISTINCT i."sourceLotteryDrawId" AS id
          FROM "VipBenefitGrantInstance" i
          WHERE i."grantedAt" >= $1
            AND i."grantedAt" <= $2
            AND i."deliveryKind" = 'LOTTERY'
            AND i.status = 'ACTIVE'
            AND i."sourceLotteryDrawId" IS NOT NULL
        )
        UPDATE "LotteryDraw" d
        SET status = 'EXPIRED',
            "expiresAt" = NOW()
        FROM target
        WHERE d.id = target.id
          AND d.status = 'UNUSED'
        RETURNING d.id
      `,
      [windowStart, windowEnd],
    );

    const finalizedCouponInstances = await client.query(
      `
        UPDATE "VipBenefitGrantInstance" i
        SET status = 'FINALIZED',
            "finalizedAt" = NOW()
        WHERE i."grantedAt" >= $1
          AND i."grantedAt" <= $2
          AND i."deliveryKind" = 'COUPON'
          AND i.status = 'ACTIVE'
        RETURNING i.id
      `,
      [windowStart, windowEnd],
    );

    const finalizedLotteryInstances = await client.query(
      `
        UPDATE "VipBenefitGrantInstance" i
        SET status = 'FINALIZED',
            "finalizedAt" = NOW()
        WHERE i."grantedAt" >= $1
          AND i."grantedAt" <= $2
          AND i."deliveryKind" = 'LOTTERY'
          AND i.status = 'ACTIVE'
        RETURNING i.id
      `,
      [windowStart, windowEnd],
    );

    const pointRollback = await client.query(
      `
        WITH point_totals AS (
          SELECT
            g."discordUserId",
            SUM(i."pointsAmount") AS points_to_revoke
          FROM "VipBenefitGrant" g
          JOIN "VipBenefitGrantInstance" i ON i."grantId" = g.id
          WHERE i."grantedAt" >= $1
            AND i."grantedAt" <= $2
            AND i."deliveryKind" = 'POINTS'
          GROUP BY g."discordUserId"
        )
        UPDATE "JinleeUser" ju
        SET "loyaltyPoints" = GREATEST(0::numeric, ju."loyaltyPoints" - point_totals.points_to_revoke)
        FROM point_totals
        WHERE ju."discordUserId" = point_totals."discordUserId"
        RETURNING ju."discordUserId", point_totals.points_to_revoke
      `,
      [windowStart, windowEnd],
    );

    const mirroredPointRollback = await client.query(
      `
        WITH point_totals AS (
          SELECT
            g."discordUserId",
            SUM(i."pointsAmount") AS points_to_revoke
          FROM "VipBenefitGrant" g
          JOIN "VipBenefitGrantInstance" i ON i."grantId" = g.id
          WHERE i."grantedAt" >= $1
            AND i."grantedAt" <= $2
            AND i."deliveryKind" = 'POINTS'
          GROUP BY g."discordUserId"
        )
        UPDATE "LoyaltyPoint" lp
        SET points = GREATEST(0::numeric, lp.points - point_totals.points_to_revoke)
        FROM point_totals
        WHERE lp."discordUserId" = point_totals."discordUserId"
        RETURNING lp."discordUserId", point_totals.points_to_revoke
      `,
      [windowStart, windowEnd],
    );

    await client.query('COMMIT');

    console.log('Rollback applied');
    console.table([
      { operation: 'expire_coupons', count: expiredCoupons.rowCount ?? 0 },
      { operation: 'expire_lottery_draws', count: expiredLotteryDraws.rowCount ?? 0 },
      { operation: 'finalize_coupon_instances', count: finalizedCouponInstances.rowCount ?? 0 },
      { operation: 'finalize_lottery_instances', count: finalizedLotteryInstances.rowCount ?? 0 },
      { operation: 'revoke_jinlee_points_rows', count: pointRollback.rowCount ?? 0 },
      { operation: 'revoke_mirrored_points_rows', count: mirroredPointRollback.rowCount ?? 0 },
    ]);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    await client.end();
  }
}

await main();
