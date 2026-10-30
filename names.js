// 대표 세션 id 앞에 붙는 표식. 다른 문자를 원하면 이 상수만 바꾸면 된다.
export const REPRESENTATIVE_MARK = '*';

// 같은 이름이 여러 레코드로 남을 수 있다(세션 재개 등). 하나로 합치지 않고 모두 보여주되, 이름이 겹치는 것은
// 레코드 id 앞 4글자를 붙여 구분한다(예: contract-developer[8055]). 이름이 하나뿐이면 그대로 둔다.
// 겹치는 이름 중 pid가 있는 레코드 가운데 startedAt이 가장 큰 것이 대표 세션(실제로 메시지를 받는 쪽)이며,
// id 앞에 REPRESENTATIVE_MARK를 붙이고 isRepresentative를 켠다(렌더에서 굵게). pid 있는 레코드가 없으면 대표 없음.
export function disambiguateNames(records) {
  const counts = new Map();
  for (const rec of records) counts.set(rec.name, (counts.get(rec.name) || 0) + 1);

  const representatives = new Map();
  for (const rec of records) {
    if (counts.get(rec.name) <= 1 || !rec.pid) continue;
    const best = representatives.get(rec.name);
    if (!best || (rec.startedAt || 0) > (best.startedAt || 0)) representatives.set(rec.name, rec);
  }

  return records.map((rec) => {
    if (counts.get(rec.name) <= 1) return rec;
    const isRepresentative = representatives.get(rec.name) === rec;
    // id가 없는 레코드(interactive 세션 등)는 [..]를 붙이지 않고 이름만 둔다(대표면 굵게만 표시).
    if (!rec.id) return { ...rec, isRepresentative };
    const mark = isRepresentative ? REPRESENTATIVE_MARK : '';
    return { ...rec, name: `${rec.name}[${mark}${String(rec.id).slice(0, 4)}]`, isRepresentative };
  });
}
