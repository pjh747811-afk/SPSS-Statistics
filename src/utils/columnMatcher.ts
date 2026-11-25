import {
  ColumnProfile,
  ConstructMapping,
  RecommendedItemMatch,
} from '../types/stats';

const ID_COL_RE =
  /^(id|no|num|index|seq|resp(?:ondent)?|timestamp|time|date|연번|번호|순번|응답자(?:id|번호)?|타임스탬프|응답일시|응답시간)$/i;

const SYNONYM_CLUSTERS: string[][] = [
  ['리더십', '카리스마', 'charisma', 'leader', 'leadership', 'transform', '변혁', '진정성'],
  ['배려', '개별배려', 'consider', 'consideration', 'support', '지원'],
  ['지적자극', '자극', 'intel', 'intellectual', 'stimul'],
  ['동기', '동기부여', 'motiv', 'motivation', 'inspir', '영감'],
  ['심리적자본', '심리자본', '심리', '자본', 'psycap', 'capital', 'efficacy', '자기효능', '희망', '탄력', '낙관'],
  ['혁신', '혁신행동', 'innov', 'innovation', 'innovative', 'creative', '창의'],
  ['만족', '직무만족', 'satisf', 'satisfaction', 'job'],
  ['몰입', '조직몰입', 'commit', 'commitment', 'engage', '몰두'],
  ['신뢰', 'trust', 'faith', 'confid'],
  ['성과', '직무성과', 'perform', 'performance', 'outcome'],
  ['이직', '이직의도', 'turnover', 'quit', 'intent'],
  ['소진', '스트레스', 'stress', 'burnout', 'exhaust'],
  ['공정', '공정성', 'justice', 'fair'],
  ['소통', '커뮤니케이션', 'comm', 'communication'],
  ['자율', '자율성', 'autonomy', 'empower', '임파워'],
];

function extractTokens(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[_\-.\s()/]+/g, ' ')
    .trim();
  if (!normalized) return [];
  const rawParts = normalized.split(' ').filter(Boolean);
  const tokens = new Set<string>();
  for (const part of rawParts) {
    tokens.add(part);
    const alphaNumSplit = part.replace(/(\D)(\d)/g, '$1 $2').replace(/(\d)(\D)/g, '$1 $2').split(' ');
    for (const sub of alphaNumSplit) {
      if (sub.length >= 1) tokens.add(sub);
    }
  }
  return Array.from(tokens);
}

function getPrefix(col: string): string {
  const m1 = col.trim().match(/^(.+?)[_\-.\s(]+(\d+)\)?$/);
  if (m1?.[1]) return m1[1].trim().toLowerCase();
  const m2 = col.trim().match(/^([^\d]+?)(\d+)$/);
  if (m2?.[1]) return m2[1].trim().toLowerCase();
  return col.trim().toLowerCase();
}

function findSynonymClusters(tokens: string[]): number[] {
  const hits: number[] = [];
  SYNONYM_CLUSTERS.forEach((cluster, idx) => {
    const matched = tokens.some((tok) =>
      cluster.some((kw) => tok.includes(kw) || (tok.length >= 2 && kw.includes(tok)))
    );
    if (matched) hits.push(idx);
  });
  return hits;
}

function scoreColumnForConstruct(
  construct: ConstructMapping,
  col: string,
  profile?: ColumnProfile
): { score: number; reason: string } {
  const colLower = col.trim().toLowerCase();
  const colPrefix = getPrefix(col);
  const colTokens = extractTokens(col);

  const priorItems = Array.from(
    new Set([...(construct.items ?? []), ...(construct.surveyItemIds ?? [])])
  );

  // Exclude obvious ID columns or empty/text-only columns unless prior name matches
  const isPriorExact = priorItems.some((it) => it.trim().toLowerCase() === colLower);
  if (isPriorExact) {
    return { score: 0.98, reason: '이전 문항명 정확 일치' };
  }

  if (ID_COL_RE.test(col.trim())) {
    return { score: 0, reason: '' };
  }
  if (profile && (profile.kind === 'empty' || profile.kind === 'constant' || profile.kind === 'text')) {
    if (construct.role !== 'control') {
      return { score: 0, reason: '' };
    }
  }

  let bestScore = 0;
  let bestReason = '';

  const nameClean = construct.name.trim().toLowerCase();
  const nameTokens = extractTokens(construct.name);

  // 1. Construct name appears inside column prefix/name or vice versa
  if (nameClean.length >= 2 && (colPrefix === nameClean || colLower.startsWith(nameClean))) {
    bestScore = Math.max(bestScore, 0.92);
    bestReason = '구성개념명 접두 일치';
  } else if (nameClean.length >= 2 && colLower.includes(nameClean)) {
    bestScore = Math.max(bestScore, 0.85);
    bestReason = '구성개념명 부분 일치';
  } else if (colPrefix.length >= 2 && nameClean.includes(colPrefix)) {
    bestScore = Math.max(bestScore, 0.78);
    bestReason = '컬럼 접두어 일치';
  }

  // 2. Prior item prefixes match new column prefix
  for (const prev of priorItems) {
    const prevPrefix = getPrefix(prev);
    if (prevPrefix.length >= 2 && prevPrefix === colPrefix) {
      bestScore = Math.max(bestScore, 0.84);
      bestReason = `이전 문항 접두어(${prev}) 일치`;
    }
  }

  // 3. Token overlap between construct name / prior items and column
  const refTokens = new Set<string>([
    ...nameTokens,
    ...priorItems.flatMap((it) => extractTokens(it)),
  ]);
  const overlap = colTokens.filter(
    (t) => t.length >= 2 && !/^\d+$/.test(t) && refTokens.has(t)
  );
  if (overlap.length > 0) {
    const tokenScore = Math.min(0.82, 0.52 + overlap.length * 0.15);
    if (tokenScore > bestScore) {
      bestScore = tokenScore;
      bestReason = `키워드(${overlap.slice(0, 2).join(', ')}) 일치`;
    }
  }

  // 4. Semantic synonym cluster match
  const nameClusters = findSynonymClusters(Array.from(refTokens));
  const colClusters = findSynonymClusters(colTokens);
  const sharedClusters = nameClusters.filter((idx) => colClusters.includes(idx));
  if (sharedClusters.length > 0 && bestScore < 0.72) {
    bestScore = 0.72;
    bestReason = '의미 영역 유사어 추천';
  }

  // Slight boost if numeric column (expected for Likert survey items)
  if (bestScore > 0 && profile?.kind === 'numeric') {
    bestScore = Math.min(0.99, bestScore + 0.04);
  }

  return { score: Number(bestScore.toFixed(2)), reason: bestReason };
}

/**
 * Generates candidate column recommendations for all registered constructs
 * when a new dataset is uploaded, WITHOUT auto-confirming items solely by name.
 */
export function recommendColumnsForConstructs(
  constructs: ConstructMapping[],
  columns: string[],
  columnProfiles: ColumnProfile[] = [],
  options: { preserveExistingConfirmed?: boolean } = {}
): ConstructMapping[] {
  const profileMap = new Map(columnProfiles.map((p) => [p.name, p]));
  const colSet = new Set(columns);

  return constructs.map((construct) => {
    const priorNames = construct.items.length
      ? construct.items
      : construct.surveyItemIds ?? [];

    const scored: RecommendedItemMatch[] = [];
    for (const col of columns) {
      const { score, reason } = scoreColumnForConstruct(construct, col, profileMap.get(col));
      if (score >= 0.45) {
        scored.push({ column: col, score, reason });
      }
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.column.localeCompare(b.column, 'ko', { numeric: true });
    });

    // Cap to sensible candidate group (if top candidates share a prefix, prioritize them)
    const topMatches = scored.slice(0, 12);

    if (options.preserveExistingConfirmed && construct.confirmed && construct.items.length > 0) {
      const valid = construct.items.filter((it) => colSet.has(it));
      const missing = construct.items.filter((it) => !colSet.has(it));
      return {
        ...construct,
        items: valid,
        reverseItems: (construct.reverseItems ?? []).filter((it) => valid.includes(it)),
        recommendedItems: topMatches,
        missingMatchedItems: missing,
        confirmed: missing.length === 0 && valid.length > 0,
      };
    }

    // New dataset replacement: DO NOT auto-confirm items; clear items and require user confirmation!
    return {
      ...construct,
      surveyItemIds: construct.surveyItemIds?.length ? construct.surveyItemIds : priorNames,
      items: [],
      reverseItems: [],
      recommendedItems: topMatches,
      missingMatchedItems: priorNames.filter((it) => !colSet.has(it)),
      confirmed: false,
      mappingStatus: 'needs_mapping',
    };
  });
}

/**
 * Explicitly confirms recommended columns into construct.items on user action.
 * Avoids assigning the same column to multiple constructs unless already explicitly selected.
 */
export function applyRecommendedMatches(
  constructs: ConstructMapping[],
  targetConstructId?: string
): ConstructMapping[] {
  const alreadyClaimed = new Set<string>();
  for (const c of constructs) {
    if (targetConstructId && c.id !== targetConstructId) {
      c.items.forEach((it) => alreadyClaimed.add(it));
    }
  }

  return constructs.map((c) => {
    if (targetConstructId && c.id !== targetConstructId) return c;
    const candidates = (c.recommendedItems ?? [])
      .filter((r) => r.score >= 0.45 && !alreadyClaimed.has(r.column))
      .map((r) => r.column);

    if (!candidates.length) return c;
    candidates.forEach((col) => alreadyClaimed.add(col));

    // Preserve numeric item order
    const sorted = [...candidates].sort((a, b) =>
      a.localeCompare(b, 'ko', { numeric: true })
    );

    return {
      ...c,
      items: sorted,
      reverseItems: (c.reverseItems ?? []).filter((it) => sorted.includes(it)),
      missingMatchedItems: [],
      confirmed: true,
    };
  });
}
