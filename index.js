import React, { useState, useEffect, useRef } from 'react';
import { render, Box, Text, useInput, useStdin } from 'ink';
import { exec } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';

const h = React.createElement;

const POLL_MS = 10000;
const MAX_CONTENT_WIDTH = 72;
// title(1) + blank(1) + blank(1) + footnote(1) + border 위아래(2). groupLines 몫을 뺀 나머지 고정 줄 수.
const FIXED_CHROME_LINES = 6;

// [라벨, 글자색] 순서가 그대로 화면에 묶어 보여줄 순서다(조치가 필요한 쪽을 위로).
const GROUPS = [
  ['blocked', '막힘', 'red'],
  ['failed', '실패', 'red'],
  ['working', '작업중', 'green'],
  ['idle', '대기', 'yellow'],
  ['stopped', '종료', 'gray'],
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
function categorize(rec) {
  if (rec.pid) {
    return rec.status === 'busy' ? 'working' : 'idle';
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

function Board() {
  const [byCategory, setByCategory] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [lastError, setLastError] = useState(null);
  // 한 번에 한 묶음만 이름까지 펼쳐 보여주고(기본: 작업중), 나머지는 "[라벨] (N개)"로 접어 둔다.
  const [expandedKey, setExpandedKey] = useState('working');

  const { isRawModeSupported } = useStdin();
  useInput(
    (input, key) => {
      if (input !== 'n' || !byCategory) return;
      const nonEmptyKeys = GROUPS.filter(([k]) => byCategory.get(k).length > 0).map(([k]) => k);
      if (nonEmptyKeys.length === 0) return;
      const idx = nonEmptyKeys.indexOf(expandedKey);
      setExpandedKey(nonEmptyKeys[(idx + 1) % nonEmptyKeys.length]);
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
  let titleColor = 'gray';
  if (!lastUpdated) {
    titleSuffix = '(불러오는 중...)';
  } else if (lastError) {
    titleSuffix = `(${lastError} 갱신 실패, ${lastUpdated} 값 표시)`;
    titleColor = 'red';
  } else {
    titleSuffix = `(${lastUpdated} 갱신)`;
  }

  const footnoteTag = '시간: transcript 수정 시간 경과 추정값';
  const titleText = `Claude 세션 현황  ${titleSuffix}`;
  const hotkeyHint = isRawModeSupported ? 'N키: Next' : '';
  const titleRowText = hotkeyHint ? `${titleText} ${hotkeyHint}` : titleText;

  const nonEmptyGroups = byCategory ? GROUPS.filter(([key]) => byCategory.get(key).length > 0) : [];
  const nonEmptyKeys = nonEmptyGroups.map(([key]) => key);
  const effectiveExpandedKey = nonEmptyKeys.includes(expandedKey) ? expandedKey : nonEmptyKeys[0];

  // 터미널(분할 패널) 행 수보다 묶음 줄이 많아지면 테두리 위쪽이 화면 밖으로 밀려 올라간다(실측).
  // 그래서 펼친 묶음의 이름 목록을, 패널에 다 들어가는 만큼만 보여주고 나머지는 "...그 외 N개 더"로 줄인다.
  const terminalRows = process.stdout.rows || 24;
  const availableForGroups = Math.max(1, terminalRows - FIXED_CHROME_LINES);
  const otherGroupsCount = Math.max(0, nonEmptyGroups.length - 1);
  const budgetForEntries = Math.max(0, availableForGroups - otherGroupsCount - 1 /* 펼친 묶음 헤더 줄 */);

  const groupLines = (byCategory
    ? nonEmptyGroups.flatMap(([key, label, color]) => {
        const entries = byCategory.get(key);
        if (key !== effectiveExpandedKey) {
          return [{ text: `[${label}] (${entries.length}개, n으로 펼치기)`, color, dim: true }];
        }
        if (entries.length <= budgetForEntries) {
          return [
            { text: `[${label}]`, color },
            ...entries.map((e) => ({ text: `  ${e.name}(${e.elapsed})`, color })),
          ];
        }
        if (budgetForEntries <= 0) {
          return [{ text: `[${label}] (${entries.length}개, 화면 높이 부족해 숨김)`, color, dim: true }];
        }
        const shown = entries.slice(0, budgetForEntries - 1);
        const hiddenCount = entries.length - shown.length;
        return [
          { text: `[${label}]`, color },
          ...shown.map((e) => ({ text: `  ${e.name}(${e.elapsed})`, color })),
          { text: `  ...그 외 ${hiddenCount}개 더(화면 높이 부족)`, color, dim: true },
        ];
      })
    : [{ text: '[...] 불러오는 중', color: 'gray' }]
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
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1, width: boardWidth },
    h(
      Box,
      { justifyContent: 'space-between' },
      h(
        Box,
        null,
        h(Text, { color: 'cyan' }, 'Claude 세션 현황  '),
        h(Text, { color: titleColor }, titleSuffix),
      ),
      hotkeyHint ? h(Text, { color: 'gray' }, hotkeyHint) : null,
    ),
    h(Box, { height: 1 }),
    ...groupLines.map((g, i) => h(Text, { key: `g${i}`, color: g.color, dimColor: Boolean(g.dim) }, g.text)),
    h(Box, { height: 1 }),
    h(
      Box,
      { justifyContent: 'flex-end' },
      h(Text, { color: 'magenta' }, footnoteTag),
    ),
  );
}

render(h(Board));
