// 테마(테두리·제목 색) 정의. index.js는 ACTIVE_THEME으로 아래 중 하나만 골라 쓴다.
// named color('cyan'/'magenta' 등)는 터미널 커스텀 색상표가 재정의할 수 있어서(server-status-board
// 에서 실측 확인: 테두리·제목이 엉뚱한 색으로 보임) 전부 hex로 적는다 — hex는 터미널 테마
// 재정의를 안 탄다. server-status-board의 theme.js와 같은 28개 목록을 그대로 쓴다.
export const THEMES = {
  cherry: { border: '#D946EF', title: '#3B82F6' },
  ocean: { border: '#06B6D4', title: '#0EA5E9' },
  emerald: { border: '#10B981', title: '#22C55E' },
  amber: { border: '#F59E0B', title: '#FBBF24' },
  slate: { border: '#94A3B8', title: '#E2E8F0' },
  indigo: { border: '#6366F1', title: '#8B5CF6' },
  rose: { border: '#FB7185', title: '#FDBA74' },
  navy: { border: '#1E40AF', title: '#93C5FD' },
  sunset: { border: '#FB923C', title: '#FDE68A' },
  mint: { border: '#34D399', title: '#A3E635' },
  plum: { border: '#A855F7', title: '#E9D5FF' },
  tealGold: { border: '#0D9488', title: '#FACC15' },
  silver: { border: '#D1D5DB', title: '#F9FAFB' },
  violetPink: { border: '#7C3AED', title: '#F472B6' },
  copper: { border: '#B45309', title: '#FEF3C7' },
  forestNight: { border: '#166534', title: '#BBF7D0' },
  iceBlue: { border: '#BAE6FD', title: '#38BDF8' },
  wine: { border: '#881337', title: '#FDA4AF' },
  charcoalNeon: { border: '#374151', title: '#39FF14' },
  peacock: { border: '#0E7490', title: '#67E8F9' },
  royalGold: { border: '#581C87', title: '#FACC15' },
  warmStone: { border: '#57534E', title: '#D6D3D1' },
  midnightTeal: { border: '#042F2E', title: '#2DD4BF' },
  blushMauve: { border: '#D8B4FE', title: '#FBCFE8' },
  electricBlue: { border: '#2563EB', title: '#FFFFFF' },
  olive: { border: '#4D7C0F', title: '#FEF9C3' },
  obsidianIce: { border: '#111827', title: '#A5F3FC' },
  candy: { border: '#F9A8D4', title: '#C4B5FD' },
};

// 기존 'cyan' 테두리·제목과 가장 가까운 테마라 기본값으로 둔다.
export const DEFAULT_THEME = 'peacock';

// 묶음별 상태색·미주색은 테마와 무관하게 의미가 고정된 색(막힘·실패=빨강 등)이라 테마 객체
// 밖에 따로 둔다 — 테마를 바꿔도 이 색들은 안 바뀐다.
export const STATUS_COLORS = {
  blocked: '#EF4444', // red
  failed: '#EF4444', // red
  working: '#22C55E', // green
  resident: '#3B82F6', // blue
  idle: '#EAB308', // yellow
  stopped: '#6B7280', // gray
  error: '#EF4444', // red — 제목 갱신 실패 표시
  suffix: '#6B7280', // gray — 제목 괄호 안 문구 기본색·단축키 안내 등 보조 텍스트
  footnote: '#6B7280', // gray — 하단 미주
};

export function resolveTheme(name) {
  return THEMES[name] || THEMES[DEFAULT_THEME];
}
