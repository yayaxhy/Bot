import type { StoredBossPortrait } from '../services/bossProfileService.js';

type Notice = {
  type: 'success' | 'error';
  message: string;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(value: number) {
  return `¥${value.toFixed(2)}`;
}

function formatDateTime(value: Date | null) {
  if (!value) return '未知';
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, '0');
  const day = `${value.getDate()}`.padStart(2, '0');
  const hour = `${value.getHours()}`.padStart(2, '0');
  const minute = `${value.getMinutes()}`.padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function renderNotice(notice?: Notice | null) {
  if (!notice?.message) return '';
  return `
    <section class="notice ${notice.type}">
      ${escapeHtml(notice.message)}
    </section>
  `;
}

function renderRows(profiles: StoredBossPortrait[]) {
  if (profiles.length === 0) {
    return `
      <tr>
        <td colspan="10" class="empty">还没有生成过任何老板画像。</td>
      </tr>
    `;
  }

  return profiles
    .map((profile) => {
      const gameText = profile.topGames.length > 0 ? profile.topGames.join('、') : '暂未识别';
      const evidenceText =
        profile.evidenceLines.length > 0
          ? `<details><summary>查看证据</summary><div class="evidence">${profile.evidenceLines
              .map((line) => escapeHtml(line))
              .join('<br>')}</div></details>`
          : '无';

      return `
        <tr>
          <td>
            <div class="boss-name">${escapeHtml(profile.displayName)}</div>
            <div class="boss-id">${escapeHtml(profile.bossId)}</div>
          </td>
          <td>${escapeHtml(gameText)}</td>
          <td>${escapeHtml(profile.styleLabel)}</td>
          <td>${escapeHtml(profile.preferredCompanionLabel)}</td>
          <td>${escapeHtml(profile.rankLabel)}</td>
          <td>
            <div>${escapeHtml(profile.spendLevelLabel)}</div>
            <div class="sub">总消费 ${escapeHtml(formatMoney(profile.totalSpentSnapshot))}</div>
            <div class="sub">余额 ${escapeHtml(formatMoney(profile.totalBalanceSnapshot))}</div>
          </td>
          <td>
            <div>派单 ${profile.totalRequestCount}</div>
            <div class="sub">完结 ${profile.totalEndedOrderCount}</div>
            <div class="sub">抢单均值 ${profile.averageClickCount.toFixed(2)}</div>
          </td>
          <td>
            <div>客单价 ${escapeHtml(formatMoney(profile.averageSpendPerOrder))}</div>
            <div class="sub">单价 ${escapeHtml(formatMoney(profile.averageUnitPrice))}/小时</div>
            <div class="sub">${escapeHtml(profile.activeWindowLabel)}</div>
          </td>
          <td>
            <div>${escapeHtml(formatDateTime(profile.updatedAt))}</div>
            <div class="sub">首次样本 ${escapeHtml(formatDateTime(profile.firstSeenAt))}</div>
          </td>
          <td>
            <form method="post" action="/admin/boss-profiles/generate" class="inline-form">
              <input type="hidden" name="bossId" value="${escapeHtml(profile.bossId)}" />
              <input type="hidden" name="sampleSize" value="50" />
              <button type="submit" class="secondary-btn">刷新</button>
            </form>
            <div class="sub">${escapeHtml(profile.repeatWorkerLabel)}</div>
            <div class="sub">${evidenceText}</div>
          </td>
        </tr>
      `;
    })
    .join('');
}

export function renderBossProfileAdminPage(params: {
  profiles: StoredBossPortrait[];
  notice?: Notice | null;
}) {
  const { profiles, notice } = params;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>老板画像管理</title>
  <style>
    :root {
      --bg: #f5efe4;
      --panel: rgba(255, 250, 242, 0.92);
      --ink: #271f1a;
      --muted: #6e6257;
      --line: rgba(39, 31, 26, 0.12);
      --accent: #b34a2f;
      --accent-deep: #7f2f1d;
      --success: #dcefdc;
      --error: #f8dbd6;
      --shadow: 0 18px 44px rgba(79, 46, 24, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(226, 201, 154, 0.45), transparent 32%),
        linear-gradient(180deg, #f7f1e6 0%, #f2eadb 100%);
      font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
    }
    .shell {
      width: min(1480px, calc(100vw - 32px));
      margin: 24px auto 48px;
    }
    .hero, .panel {
      background: var(--panel);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.8);
      border-radius: 24px;
      box-shadow: var(--shadow);
    }
    .hero {
      padding: 28px 30px;
      margin-bottom: 18px;
      position: relative;
      overflow: hidden;
    }
    .hero::after {
      content: "";
      position: absolute;
      inset: auto -80px -120px auto;
      width: 280px;
      height: 280px;
      background: radial-gradient(circle, rgba(179, 74, 47, 0.18), transparent 68%);
      pointer-events: none;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 34px;
      letter-spacing: 1px;
    }
    .desc {
      margin: 0;
      max-width: 880px;
      color: var(--muted);
      line-height: 1.7;
      font-size: 15px;
    }
    .notice {
      margin: 0 0 18px;
      padding: 14px 16px;
      border-radius: 18px;
      border: 1px solid var(--line);
      font-size: 14px;
    }
    .notice.success { background: var(--success); }
    .notice.error { background: var(--error); }
    .toolbar {
      display: grid;
      grid-template-columns: 1.5fr 0.7fr auto;
      gap: 12px;
      padding: 20px;
      margin-bottom: 18px;
      align-items: end;
    }
    .batch-toolbar {
      display: grid;
      grid-template-columns: 0.7fr auto auto;
      gap: 12px;
      padding: 20px;
      margin-bottom: 18px;
      align-items: end;
    }
    label {
      display: block;
      font-size: 13px;
      color: var(--muted);
      margin-bottom: 8px;
    }
    input {
      width: 100%;
      padding: 13px 14px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.75);
      color: var(--ink);
      font-size: 15px;
    }
    button {
      border: 0;
      border-radius: 14px;
      padding: 13px 18px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 700;
      transition: transform .14s ease, opacity .14s ease;
    }
    button:hover { transform: translateY(-1px); }
    .primary-btn {
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-deep) 100%);
      color: #fff7f2;
    }
    .secondary-btn {
      background: rgba(39, 31, 26, 0.08);
      color: var(--ink);
      padding: 10px 14px;
    }
    .ghost-btn {
      background: rgba(179, 74, 47, 0.12);
      color: var(--accent-deep);
    }
    .panel {
      padding: 16px 16px 10px;
    }
    .count-line {
      margin: 0 0 12px;
      color: var(--muted);
      font-size: 13px;
    }
    .table-wrap {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 1280px;
    }
    th, td {
      padding: 14px 12px;
      vertical-align: top;
      border-bottom: 1px solid var(--line);
      text-align: left;
      font-size: 14px;
      line-height: 1.55;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    .boss-name {
      font-weight: 700;
      margin-bottom: 4px;
    }
    .boss-id, .sub, .empty {
      color: var(--muted);
      font-size: 12px;
    }
    .empty {
      padding: 32px 12px;
      text-align: center;
    }
    .inline-form { margin-bottom: 10px; }
    details summary {
      cursor: pointer;
      color: var(--accent-deep);
    }
    .evidence {
      margin-top: 8px;
      white-space: normal;
      color: var(--muted);
    }
    @media (max-width: 900px) {
      .shell { width: min(100vw - 16px, 100%); }
      .hero, .panel { border-radius: 20px; }
      .toolbar {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <h1>老板画像管理</h1>
      <p class="desc">
        这里直接调用机器人服务端的画像分析逻辑，不需要再走 Discord 命令。
        可以单个生成，也可以批量重刷全部老板，或只补齐还没建档的老板。
      </p>
    </section>
    ${renderNotice(notice)}
    <form method="post" action="/admin/boss-profiles/generate" class="panel toolbar">
      <div>
        <label for="bossId">老板 Discord ID</label>
        <input id="bossId" name="bossId" placeholder="例如 1421651539247894549" required />
      </div>
      <div>
        <label for="sampleSize">抽样条数</label>
        <input id="sampleSize" name="sampleSize" type="number" min="20" max="200" value="50" />
      </div>
      <div>
        <button type="submit" class="primary-btn">生成 / 刷新画像</button>
      </div>
    </form>
    <form method="post" action="/admin/boss-profiles/generate-all" class="panel batch-toolbar">
      <div>
        <label for="batchSampleSize">批量抽样条数</label>
        <input id="batchSampleSize" name="sampleSize" type="number" min="20" max="200" value="50" />
      </div>
      <div>
        <button type="submit" class="primary-btn">批量生成全部老板画像</button>
      </div>
      <div>
        <button type="submit" formaction="/admin/boss-profiles/generate-missing" class="ghost-btn">只生成未建档老板画像</button>
      </div>
    </form>
    <section class="panel">
      <p class="count-line">当前已入库画像数：${profiles.length}</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>老板</th>
              <th>常玩游戏</th>
              <th>玩法风格</th>
              <th>陪玩偏好</th>
              <th>段位推断</th>
              <th>消费画像</th>
              <th>样本</th>
              <th>价格/时段</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${renderRows(profiles)}
          </tbody>
        </table>
      </div>
    </section>
  </main>
</body>
</html>`;
}
