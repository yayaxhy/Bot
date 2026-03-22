import { PeiwanGameCode, PeiwanGameTier } from '@prisma/client';

type PeiwanRoleCatalogEntry = {
  roleId: string;
  gameCode: PeiwanGameCode;
  tier: PeiwanGameTier;
  label: string;
};

export const PEIWAN_ROLE_CATALOG: PeiwanRoleCatalogEntry[] = [
  { roleId: '1478020917404893321', gameCode: PeiwanGameCode.DELTA, tier: PeiwanGameTier.DEMON_GUARD, label: '三角洲魔王护' },
  { roleId: '1446160852473483315', gameCode: PeiwanGameCode.VAL, tier: PeiwanGameTier.MASTER, label: '瓦 - 大神陪玩' },
  { roleId: '1446160838535942287', gameCode: PeiwanGameCode.DELTA, tier: PeiwanGameTier.MASTER, label: '三角洲大神陪玩' },
  { roleId: '1446164005189062819', gameCode: PeiwanGameCode.CSGO, tier: PeiwanGameTier.MASTER, label: 'CS大神陪玩' },
  { roleId: '1446160863089393736', gameCode: PeiwanGameCode.APEX, tier: PeiwanGameTier.MASTER, label: 'Apex大神陪玩' },
  { roleId: '1446160854352531588', gameCode: PeiwanGameCode.LOL, tier: PeiwanGameTier.MASTER, label: 'LoL大神陪玩' },
  { roleId: '1446160861977776128', gameCode: PeiwanGameCode.TFT, tier: PeiwanGameTier.MASTER, label: 'TFT大神陪玩' },
  { roleId: '1446160853324791900', gameCode: PeiwanGameCode.OW, tier: PeiwanGameTier.MASTER, label: 'OW大神陪玩' },
  { roleId: '1446160737478119576', gameCode: PeiwanGameCode.NARAKA, tier: PeiwanGameTier.MASTER, label: 'Naraka大神陪玩' },
  { roleId: '1446163998587228221', gameCode: PeiwanGameCode.COD, tier: PeiwanGameTier.MASTER, label: 'COD大神陪玩' },
  { roleId: '1446164001468973147', gameCode: PeiwanGameCode.TARKOV, tier: PeiwanGameTier.MASTER, label: '塔可夫大神陪玩' },
  { roleId: '1446164003410673734', gameCode: PeiwanGameCode.DOTA, tier: PeiwanGameTier.MASTER, label: 'DOTA大神陪玩' },
  { roleId: '1446160901026873506', gameCode: PeiwanGameCode.MARVEL, tier: PeiwanGameTier.MASTER, label: '漫威争锋大神陪玩' },
  { roleId: '1431709900811145391', gameCode: PeiwanGameCode.VAL, tier: PeiwanGameTier.TECH, label: '瓦 - 技术陪玩' },
  { roleId: '1431708824603201567', gameCode: PeiwanGameCode.DELTA, tier: PeiwanGameTier.TECH, label: '三角洲技术陪玩' },
  { roleId: '1431717739776708939', gameCode: PeiwanGameCode.CSGO, tier: PeiwanGameTier.TECH, label: 'CS技术陪玩' },
  { roleId: '1431714450158653550', gameCode: PeiwanGameCode.APEX, tier: PeiwanGameTier.TECH, label: 'Apex技术陪玩' },
  { roleId: '1431713191293096069', gameCode: PeiwanGameCode.LOL, tier: PeiwanGameTier.TECH, label: 'LoL技术陪玩' },
  { roleId: '1431716185048612894', gameCode: PeiwanGameCode.TFT, tier: PeiwanGameTier.TECH, label: 'TFT技术陪玩' },
  { roleId: '1431708158468030525', gameCode: PeiwanGameCode.OW, tier: PeiwanGameTier.TECH, label: 'OW技术陪玩' },
  { roleId: '1431716876420907089', gameCode: PeiwanGameCode.COD, tier: PeiwanGameTier.TECH, label: 'COD技术陪玩' },
  { roleId: '1431704913725096038', gameCode: PeiwanGameCode.NARAKA, tier: PeiwanGameTier.TECH, label: 'Naraka技术陪玩' },
  { roleId: '1436432836864250059', gameCode: PeiwanGameCode.TARKOV, tier: PeiwanGameTier.TECH, label: '塔可夫技术陪玩' },
  { roleId: '1431717320237256715', gameCode: PeiwanGameCode.DOTA, tier: PeiwanGameTier.TECH, label: 'Dota技术陪玩' },
  { roleId: '1431714981669376050', gameCode: PeiwanGameCode.MARVEL, tier: PeiwanGameTier.TECH, label: '漫威争锋技术陪玩' },
  { roleId: '1470891285232619613', gameCode: PeiwanGameCode.VAL, tier: PeiwanGameTier.TRAINEE, label: '瓦见习技术陪玩' },
  { roleId: '1431711303856292021', gameCode: PeiwanGameCode.CHAT, tier: PeiwanGameTier.ENTERTAINMENT, label: '哄睡语聊' },
  { roleId: '1431711832292200488', gameCode: PeiwanGameCode.SINGER, tier: PeiwanGameTier.ENTERTAINMENT, label: '歌手' },
];

export const PEIWAN_ROLE_CATALOG_BY_ID = new Map(
  PEIWAN_ROLE_CATALOG.map((entry) => [entry.roleId, entry]),
);

const GAME_LABELS: Record<PeiwanGameCode, string> = {
  [PeiwanGameCode.LOL]: 'LoL',
  [PeiwanGameCode.CSGO]: 'CS',
  [PeiwanGameCode.VAL]: '瓦',
  [PeiwanGameCode.NARAKA]: 'Naraka',
  [PeiwanGameCode.OW]: 'OW',
  [PeiwanGameCode.APEX]: 'Apex',
  [PeiwanGameCode.DELTA]: '三角洲',
  [PeiwanGameCode.MARVEL]: '漫威争锋',
  [PeiwanGameCode.TFT]: 'TFT',
  [PeiwanGameCode.TARKOV]: '塔可夫',
  [PeiwanGameCode.DOTA]: 'Dota',
  [PeiwanGameCode.COD]: 'COD',
  [PeiwanGameCode.CHAT]: '哄睡语聊',
  [PeiwanGameCode.SINGER]: '歌手',
};

export function formatPeiwanRoleLabel(profile: {
  gameCode: PeiwanGameCode;
  tier: PeiwanGameTier;
  sourceRoleId?: string | null;
}) {
  const sourceRoleId = profile.sourceRoleId?.trim();
  if (sourceRoleId) {
    const mapped = PEIWAN_ROLE_CATALOG_BY_ID.get(sourceRoleId);
    if (mapped?.label) return mapped.label;
  }

  const game = GAME_LABELS[profile.gameCode] ?? profile.gameCode;
  if (profile.gameCode === PeiwanGameCode.CHAT || profile.gameCode === PeiwanGameCode.SINGER) {
    return game;
  }
  switch (profile.tier) {
    case PeiwanGameTier.DEMON_GUARD:
      return `${game}魔王护`;
    case PeiwanGameTier.MASTER:
      return `${game}大神陪玩`;
    case PeiwanGameTier.TECH:
      return `${game}技术陪玩`;
    case PeiwanGameTier.TRAINEE:
      return `${game}见习技术陪玩`;
    case PeiwanGameTier.ENTERTAINMENT:
      return game;
    default:
      return game;
  }
}
