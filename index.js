import React, { useState, useEffect, useRef } from 'react';
import { render, Box, Text, useInput, useStdin } from 'ink';
import { exec } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';
import { STATUS_COLORS, resolveTheme } from './theme.js';

const h = React.createElement;

const POLL_MS = 10000;
const MAX_CONTENT_WIDTH = 72;
// 테두리·제목 색 테마. theme.js의 THEMES 키 중 하나(server-status-board와 같은 목록).
const ACTIVE_THEME = 'rose';
const theme = resolveTheme(ACTIVE_THEME);
// title(1) + blank(1) + footnote(1) + border 위아래(2). groupLines 몫을 뺀 나머지 고정 줄 수
// (미주와 groupLines 사이의 빈 줄은 더 이상 고정폭이 아니라 justifyContent: space-between이
// 남는 공간만큼 알아서 채운다 — 그래서 여기 셈에서 뺐다).
const FIXED_CHROME_LINES = 5;

// [라벨, 글자색] 순서가 그대로 화면에 묶어 보여줄 순서다(조치가 필요한 쪽을 위로).
const GROUPS = [
  ['blocked', '막힘', STATUS_COLORS.blocked],
  ['failed', '실패', STATUS_COLORS.failed],
  ['working', '작업중', STATUS_COLORS.working],
  ['resident', '상주(루프 대기)', STATUS_COLORS.resident],
  ['idle', '대기', STATUS_COLORS.idle],
  ['stopped', '종료', STATUS_COLORS.stopped],
];

function pad(n) {
  return String(n).padStart(2, '0');
}

function nowHms() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fetchAgents() {
  return new Promise((resolve, reject) => {
    exec(
      'claude agents --all --json',
      { timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

// 콜백을 ref에 담아 interval 자체는 delayMs가 바뀔 때만 다시 건다(server-status-board와 동일 패턴).
function useInterval(callback, delayMs) {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });
  useEffect(() => {
    const id = setInterval(() => callbackRef.current(), delayMs);
    return () => clearInterval(id);
  }, [delayMs]);
}

// pid가 있으면 지금 살아있는 세션이라 status(idle/busy)를 믿는다. pid가 없으면 마지막 state로 분류한다.
// dev-session-launch SKILL.md 실측: state(특히 blocked)는 조회 순간의 스냅샷일 뿐이라 늦게 반영될 수 있다.
//
// status===idle이면서 state===working인 pid 보유 세션은 "작업중"도 "대기"도 아닌 별도 부류다
// (실측 2026-10-29: patrol-master처럼 /loop로 긴 주기(예: 25분)마다 짧게 깨어나는 세션은 그
// 틱 순간에만 busy이고 나머지 대부분은 idle/working으로 남는다 — 10초 폴링으로는 busy를
// 거의 못 잡아 항상 "대기"로만 보여서, 지금 루프를 돌리는 중인데도 작업중 묶음에 전혀 안
// 잡히는 문제가 있었다). architect-master도 같은 조건에 걸릴 수 있어 이름이 아니라 이
// status/state 조합으로 판정한다.
function categorize(rec) {
  if (rec.pid) {
    if (rec.status === 'busy') return 'working';
    if (rec.status === 'idle' && rec.state === 'working') return 'resident';
    return 'idle';
  }
  if (rec.state === 'blocked') return 'blocked';
  if (rec.state === 'failed') return 'failed';
  return 'stopped';
}

// 같은 이름이 여러 레코드로 남을 수 있다(세션 재개 등). startedAt이 가장 큰 것만 쓴다.
function dedupeByName(records) {
  const latestByName = new Map();
  for (const rec of records) {
    const prev = latestByName.get(rec.name);
    if (!prev || rec.startedAt > prev.startedAt) latestByName.set(rec.name, rec);
  }
  return [...latestByName.values()];
}

// claude agents --json에는 "마지막으로 뭘 했는지" 시각이 없다(startedAt은 세션을 처음 띄운 시각일 뿐).
// 대신 그 세션의 transcript 파일(~/.claude/projects/<cwd를 인코딩한 폴더>/<sessionId>.jsonl)의
// mtime을 "마지막 활동 시각"의 대리값으로 쓴다 — 실측: 이 폴더명은 cwd에서 영숫자·하이픈이 아닌
// 글자를 전부 '-'로 바꾼 것(예: C:\Users\... → C--Users-...).
function encodeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

async function lastActivityMs(rec) {
  try {
    const file = path.join(homedir(), '.claude', 'projects', encodeProjectDir(rec.cwd), `${rec.sessionId}.jsonl`);
    const info = await stat(file);
    return info.mtimeMs;
  } catch {
    return rec.startedAt;
  }
}

function formatElapsed(ms) {
  const diffMs = Date.now() - ms;
  if (diffMs < 60_000) return '방금';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}

async function enrichWithActivity(records) {
  return Promise.all(
    records.map(async (rec) => ({ ...rec, lastActivityMs: await lastActivityMs(rec) })),
  );
}

function groupAgents(records) {
  const byCategory = new Map(GROUPS.map(([key]) => [key, []]));
  for (const rec of records) {
    byCategory.get(categorize(rec)).push({ name: rec.name, elapsed: formatElapsed(rec.lastActivityMs) });
  }
  for (const entries of byCategory.values()) entries.sort((a, b) => a.name.localeCompare(b.name));
  return byCategory;
}

// 렌더 쪽(groupLines)과 키 입력 핸들러(nextCursor)가 똑같은 pageSize를 써야 페이지 번호가
// 어긋나지 않는다 — 그래서 이 계산을 한 곳에 모아 둔다. 펼친 묶음이 아닌 나머지는 묶음당
// 한 줄(접힌 상태)만 차지하므로, 펼친 묶음에 쓸 수 있는 줄 수(pageSize)는 전체에서 그만큼과
// 헤더 한 줄을 뺀 나머지다.
function computeGroupLayout(byCategory, terminalRows) {
  const nonEmptyGroups = byCategory ? GROUPS.filter(([key]) => byCategory.get(key).length > 0) : [];
  const nonEmptyKeys = nonEmptyGroups.map(([key]) => key);
  const availableForGroups = Math.max(1, terminalRows - FIXED_CHROME_LINES);
  const otherGroupsCount = Math.max(0, nonEmptyGroups.length - 1);
  const pageSize = Math.max(0, availableForGroups - otherGroupsCount - 1 /* 펼친 묶음 헤더 줄 */);
  return { nonEmptyGroups, nonEmptyKeys, pageSize };
}

// n 입력 시 다음 자리를 계산한다: 지금 묶음에 다음 페이지가 있으면 그쪽으로, 마지막
// 페이지였으면 다음 묶음의 첫 페이지로(한 바퀴 돌면 처음 묶음으로 돌아온다).
function nextCursor(byCategory, prev) {
  const terminalRows = process.stdout.rows || 24;
  const { nonEmptyKeys, pageSize } = computeGroupLayout(byCategory, terminalRows);
  if (nonEmptyKeys.length === 0) return prev;
  const key = nonEmptyKeys.includes(prev.key) ? prev.key : nonEmptyKeys[0];
  const entries = byCategory.get(key);
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(entries.length / pageSize)) : 1;
  if (prev.page + 1 < totalPages) {
    return { key, page: prev.page + 1 };
  }
  const idx = nonEmptyKeys.indexOf(key);
  const nextKey = nonEmptyKeys[(idx + 1) % nonEmptyKeys.length];
  return { key: nextKey, page: 0 };
}

function Board() {
  const [byCategory, setByCategory] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [lastError, setLastError] = useState(null);
  // 한 번에 한 묶음만 이름까지 펼쳐 보여주고(기본: 작업중), 나머지는 "[라벨] (N개)"로 접어 둔다.
  // 펼친 묶음도 한 화면에 다 못 들어가면 page로 나눠서 보여준다(n으로 다음 페이지, 마지막
  // 페이지에서 n을 또 누르면 다음 묶음의 첫 페이지로 넘어간다).
  const [cursor, setCursor] = useState({ key: 'working', page: 0 });

  const { isRawModeSupported } = useStdin();
  useInput(
    (input, key) => {
      if (input !== 'n' || !byCategory) return;
      setCursor((prev) => nextCursor(byCategory, prev));
    },
    { isActive: isRawModeSupported },
  );

  async function poll() {
    try {
      const records = await fetchAgents();
      const enriched = await enrichWithActivity(dedupeByName(records));
      setByCategory(groupAgents(enriched));
      setLastUpdated(nowHms());
      setLastError(null);
    } catch (err) {
      setLastError(nowHms());
    }
  }

  useEffect(() => {
    poll();
  }, []);
  useInterval(poll, POLL_MS);

  let titleSuffix;
  let titleColor = STATUS_COLORS.suffix;
  if (!lastUpdated) {
    titleSuffix = '(불러오는 중...)';
  } else if (lastError) {
    titleSuffix = `(${lastError} 갱신 실패, ${lastUpdated} 값 표시)`;
    titleColor = STATUS_COLORS.error;
  } else {
    titleSuffix = `(${lastUpdated} 갱신)`;
  }

  const footnoteTag = '🕐 시간: transcript 수정 시간 경과 추정값';
  const titleText = `Claude 세션 현황  ${titleSuffix}`;
  const hotkeyHint = isRawModeSupported ? 'N키: Next' : '';
  const titleRowText = hotkeyHint ? `${titleText} ${hotkeyHint}` : titleText;

  const terminalRows = process.stdout.rows || 24;
  const { nonEmptyGroups, nonEmptyKeys, pageSize } = computeGroupLayout(byCategory, terminalRows);
  const effectiveKey = nonEmptyKeys.includes(cursor.key) ? cursor.key : nonEmptyKeys[0];

  // 펼친 묶음의 이름 목록을 pageSize만큼씩 나눠서, n으로 다음 페이지 → 마지막 페이지에서 또
  // n을 누르면 다음 묶음의 첫 페이지로 넘어간다(nextCursor와 같은 계산을 써야 어긋나지 않는다).
  const groupLines = (byCategory
    ? nonEmptyGroups.flatMap(([key, label, color]) => {
        const entries = byCategory.get(key);
        if (key !== effectiveKey) {
          return [{ text: `[${label}] (${entries.length}개, n으로 펼치기)`, color, dim: true }];
        }
        if (pageSize <= 0) {
          return [{ text: `[${label}] (${entries.length}개, 화면 높이 부족해 숨김)`, color, dim: true }];
        }
        const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
        const page = Math.min(cursor.page, totalPages - 1);
        const pageEntries = entries.slice(page * pageSize, (page + 1) * pageSize);
        const headerText = totalPages > 1 ? `[${label}] (${page + 1}/${totalPages}페이지)` : `[${label}]`;
        return [
          { text: headerText, color },
          ...pageEntries.map((e) => ({ text: `  ${e.name}(${e.elapsed})`, color })),
        ];
      })
    : [{ text: '[...] 불러오는 중', color: STATUS_COLORS.suffix }]
  );

  const groupLinesMaxWidth = Math.max(0, ...groupLines.map((g) => stringWidth(g.text)));
  const contentWidth = Math.max(
    stringWidth(titleRowText),
    stringWidth(footnoteTag),
    Math.min(MAX_CONTENT_WIDTH, groupLinesMaxWidth),
  );
  const boardWidth = contentWidth + 2 /* paddingX 양쪽 */ + 2 /* borderStyle 양쪽 */;

  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: theme.border,
      paddingX: 1,
      width: boardWidth,
      // 내용이 짧아도 처음부터 터미널 높이만큼 테두리를 늘려 둔다(좌우 테두리가 패널 바닥까지
      // 이어진다). justifyContent: space-between으로 "위 블록"과 "미주"를 양 끝에 고정해서,
      // 내용이 얼마나 짧든 미주가 항상 하단 테두리 바로 위 줄에 오게 한다(남는 자리는 둘
      // 사이의 빈 칸으로 몰린다).
      height: terminalRows,
      justifyContent: 'space-between',
    },
    h(
      Box,
      { flexDirection: 'column' },
      h(
        Box,
        { justifyContent: 'space-between' },
        h(
          Box,
          null,
          h(Text, { color: theme.title }, 'Claude 세션 현황  '),
          h(Text, { color: titleColor }, titleSuffix),
        ),
        hotkeyHint ? h(Text, { color: STATUS_COLORS.suffix }, hotkeyHint) : null,
      ),
      h(Box, { height: 1 }),
      ...groupLines.map((g, i) => h(Text, { key: `g${i}`, color: g.color, dimColor: Boolean(g.dim) }, g.text)),
    ),
    h(
      Box,
      { justifyContent: 'flex-end' },
      h(Text, { color: STATUS_COLORS.footnote }, footnoteTag),
    ),
  );
}

render(h(Board));
