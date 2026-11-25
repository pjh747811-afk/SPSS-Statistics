import React from 'react';
import { BarChart3, CheckCircle2, GitCompare, Layers, ShieldCheck } from 'lucide-react';
import { AnalysisBundle } from '../types/stats';
import { fmtNum, fmtP, getHypothesisVerdict } from '../utils/statistics';

interface AnalysisSummaryCardsProps {
  bundle: AnalysisBundle;
}

type CardTone = 'emerald' | 'blue' | 'amber' | 'slate';

const TONE_BADGE: Record<CardTone, string> = {
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200/80',
  blue: 'bg-blue-50 text-blue-700 border-blue-200/80',
  amber: 'bg-amber-50 text-amber-800 border-amber-200/80',
  slate: 'bg-slate-100 text-slate-600 border-slate-200/80',
};

export const AnalysisSummaryCards: React.FC<AnalysisSummaryCardsProps> = ({ bundle }) => {
  // 1. 요인분석 (EFA)
  const efa = bundle.efa;
  const efaFinite = Boolean(efa && Number.isFinite(efa.kmo));
  const efaCumPct = efa
    ? efa.varianceExplained[efa.numFactors - 1]?.rotCumPct ??
      efa.varianceExplained[efa.varianceExplained.length - 1]?.initialCumPct ??
      NaN
    : NaN;
  const efaOk = Boolean(efaFinite && efa!.kmo >= 0.6 && efa!.bartlettP < 0.05);
  const efaTone: CardTone = !efa ? 'slate' : efaOk ? 'emerald' : 'amber';
  const efaBadge = !efa ? '미실행' : efaOk ? '타당도 양호' : '기준 확인 필요';
  const efaPlainSummary = !efa
    ? '요인분석을 실행할 문항이 부족해 문항 묶임 정도를 확인하지 못했습니다.'
    : !efaFinite
      ? '표본 수 부족 또는 문항 중복으로 KMO 값이 산출되지 않아 문항 구성을 점검해 주세요.'
      : efaOk
        ? `비슷한 질문끼리 잘 묶였는지 확인한 결과, KMO ${fmtNum(efa.kmo, 3)}로 설문 구성이 탄탄합니다.`
        : efa.kmo < 0.6
          ? `문항들이 묶이는 힘(KMO ${fmtNum(efa.kmo, 3)})이 권장 기준(.60)보다 낮아 문항 정리가 필요할 수 있습니다.`
          : `요인 ${efa.numFactors}개로 묶였으나 구형성 검정(p = ${fmtNum(efa.bartlettP, 3)})이 기준을 충족하지 못했습니다.`;

  // 2. 신뢰도 (Cronbach's α)
  const multiRel = bundle.reliability.filter((r) => r.nItems >= 2 && Number.isFinite(r.alpha));
  const allFiniteAlphas = bundle.reliability
    .map((r) => r.alpha)
    .filter((a) => Number.isFinite(a));
  const relOkCount = multiRel.filter((r) => r.alpha >= 0.6).length;
  const relMin = allFiniteAlphas.length ? Math.min(...allFiniteAlphas) : NaN;
  const relMax = allFiniteAlphas.length ? Math.max(...allFiniteAlphas) : NaN;
  const relTone: CardTone = !multiRel.length
    ? 'slate'
    : relOkCount === multiRel.length
      ? 'emerald'
      : 'amber';
  const relBadge = !multiRel.length
    ? bundle.reliability.length
      ? '단일 문항'
      : '미실행'
    : relOkCount === multiRel.length
      ? '일관성 양호'
      : '일부 미달';
  const lowRelNames = multiRel
    .filter((r) => r.alpha < 0.6)
    .map((r) => r.constructName)
    .join(', ');
  const relPlainSummary = !multiRel.length
    ? '개념마다 문항이 1개씩이어서 여러 문항 간 응답 일관성(α)을 계산할 수 없습니다.'
    : relOkCount === multiRel.length
      ? relMin >= 0.7
        ? '같은 주제의 질문들에 응답자가 매우 일관되게 답해 설문 결과를 믿을 수 있습니다.'
        : '모든 개념의 응답 일관성(α)이 기본 기준(.60)을 넘어 설문 신뢰도가 확보되었습니다.'
      : `'${lowRelNames}' 항목의 응답 일관성(α)이 .60보다 낮아 일부 질문 보완이 필요합니다.`;

  // 3. 상관분석 (Pearson r)
  const { names, matrix } = bundle.correlation;
  let bestPair: { a: string; b: string; r: number; p: number } | null = null;
  let sigPairCount = 0;
  let totalPairs = 0;
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const cell = matrix[i]?.[j];
      if (!cell || !Number.isFinite(cell.r)) continue;
      totalPairs++;
      if (cell.p < 0.05) sigPairCount++;
      if (!bestPair || Math.abs(cell.r) > Math.abs(bestPair.r)) {
        bestPair = { a: names[i], b: names[j], r: cell.r, p: cell.p };
      }
    }
  }
  const corrCollinearRisk = Boolean(bestPair && Math.abs(bestPair.r) >= 0.85);
  const corrTone: CardTone = !bestPair
    ? 'slate'
    : corrCollinearRisk
      ? 'amber'
      : sigPairCount > 0
        ? 'blue'
        : 'slate';
  const corrBadge = !bestPair
    ? '미실행'
    : corrCollinearRisk
      ? '고상관 주의'
      : sigPairCount > 0
        ? `유의 ${sigPairCount}/${totalPairs}쌍`
        : '관계 미약';
  const corrPlainSummary = !bestPair
    ? '2개 이상의 개념을 지정하면 변수끼리 서로 얼마나 함께 움직이는지 확인할 수 있습니다.'
    : corrCollinearRisk
      ? `'${bestPair.a}'와 '${bestPair.b}'가 매우 강하게 겹쳐(r = ${fmtNum(bestPair.r, 3)}) 두 개념 구분을 한 번 더 확인하세요.`
      : bestPair.p < 0.05
        ? `'${bestPair.a}'이(가) 높을수록 '${bestPair.b}'도 함께 ${bestPair.r >= 0 ? '높아지는' : '낮아지는'} 뚜렷한 연관성을 보입니다.`
        : '변수들끼리 통계적으로 뚜렷하게 함께 움직이는 관계(p < .05)는 아직 나타나지 않았습니다.';

  // 4. 회귀분석 (R² · 가설 검증)
  const regs = bundle.regressions;
  const repReg = regs.find((r) => r.id === 'H3') ?? regs[0] ?? null;
  const adoptedCount = regs.filter((r) => getHypothesisVerdict(r) !== '기각').length;
  const fullAdoptedCount = regs.filter((r) => getHypothesisVerdict(r) === '채택').length;
  const hasSigMed = Boolean(
    bundle.mediation?.paths.some((p) => p.status === 'full' || p.status === 'partial')
  );
  const regTone: CardTone = !regs.length
    ? 'slate'
    : fullAdoptedCount === regs.length
      ? 'emerald'
      : adoptedCount > 0
        ? 'blue'
        : 'amber';
  const regBadge = !regs.length
    ? '미실행'
    : adoptedCount === regs.length
      ? `가설 ${adoptedCount}/${regs.length} 채택`
      : adoptedCount > 0
        ? `부분 지지 (${adoptedCount}/${regs.length})`
        : '가설 기각';
  const regPlainSummary = !repReg
    ? '독립변수와 종속변수를 설정하면 원인 변수가 결과를 얼마나 설명하는지 확인할 수 있습니다.'
    : adoptedCount > 0
      ? `원인이 결과 변화의 약 ${Math.max(0, repReg.r2 * 100).toFixed(1)}%를 설명하며, 가설 ${regs.length}개 중 ${adoptedCount}개가 데이터로 뒷받침됩니다${hasSigMed ? '(매개효과 포함)' : ''}.`
      : '현재 데이터에서는 설정한 원인 변수가 결과에 미치는 영향이 통계적으로 유의하지 않았습니다.';

  const cards = [
    {
      id: 'efa',
      step: '1. 요인분석',
      subtitle: '문항 타당도',
      icon: Layers,
      tone: efaTone,
      badge: efaBadge,
      metricLabel: 'KMO 표본적합도',
      metricValue: efaFinite ? fmtNum(efa!.kmo, 3) : '—',
      subMetrics: efa
        ? `요인 ${efa.numFactors}개 · 설명력 ${Number.isFinite(efaCumPct) ? `${fmtNum(efaCumPct, 1)}%` : '—'} · ${fmtP(efa.bartlettP)}`
        : '분석 결과 없음',
      plainSummary: efaPlainSummary,
    },
    {
      id: 'reliability',
      step: '2. 신뢰도 분석',
      subtitle: '응답 일관성',
      icon: ShieldCheck,
      tone: relTone,
      badge: relBadge,
      metricLabel: 'Cronbach α',
      metricValue: allFiniteAlphas.length
        ? allFiniteAlphas.length === 1
          ? fmtNum(relMin, 3)
          : `${fmtNum(relMin, 2)} ~ ${fmtNum(relMax, 2)}`
        : '—',
      subMetrics: multiRel.length
        ? `기준(.60 이상) ${relOkCount}/${multiRel.length}개 개념 충족`
        : '다문항 구성개념 없음',
      plainSummary: relPlainSummary,
    },
    {
      id: 'correlation',
      step: '3. 상관분석',
      subtitle: '변수 간 관계',
      icon: GitCompare,
      tone: corrTone,
      badge: corrBadge,
      metricLabel: bestPair ? `최대 상관 (${bestPair.a} ↔ ${bestPair.b})` : 'Pearson 상관계수 (r)',
      metricValue: bestPair ? `r = ${fmtNum(bestPair.r, 3)}` : '—',
      subMetrics: bestPair
        ? `${fmtP(bestPair.p)} · 총 ${names.length}개 개념 (${totalPairs}쌍)`
        : '비교할 합변수 부족',
      plainSummary: corrPlainSummary,
    },
    {
      id: 'regression',
      step: '4. 회귀분석',
      subtitle: '영향력 · 가설검정',
      icon: BarChart3,
      tone: regTone,
      badge: regBadge,
      metricLabel: repReg ? `${repReg.hypothesis} 설명력 (R² / 수정 R²)` : '설명력 (R²)',
      metricValue: repReg ? `${fmtNum(repReg.r2, 3)}` : '—',
      subMetrics: repReg
        ? `수정 R² ${fmtNum(repReg.adjR2, 3)} · F = ${fmtNum(repReg.anova.f, 2)} (${fmtP(repReg.anova.p)})`
        : '회귀모형 미실행',
      plainSummary: regPlainSummary,
    },
  ];

  return (
    <div className="py-4 sm:py-5 border-b border-slate-200 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-blue-700 shrink-0" />
          <h3 className="text-sm font-bold text-slate-900">
            분석별 핵심 지표 &amp; 쉬운 한 줄 정리
          </h3>
        </div>
        <span className="text-xs text-slate-500">
          핵심 통계 수치와 비전공자용 해석 요약
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.id}
              className="rounded-xl border border-slate-200/90 bg-slate-50/70 p-3.5 sm:p-4 flex flex-col justify-between gap-3 min-w-0"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Icon className="w-4 h-4 text-blue-700 shrink-0" />
                    <span className="text-xs font-bold text-slate-900 truncate">{card.step}</span>
                    <span className="text-xs text-slate-500 shrink-0">· {card.subtitle}</span>
                  </div>
                  <span
                    className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap shrink-0 ${TONE_BADGE[card.tone]}`}
                  >
                    {card.badge}
                  </span>
                </div>

                <div>
                  <div className="text-xs font-medium text-slate-500 truncate" title={card.metricLabel}>
                    {card.metricLabel}
                  </div>
                  <div className="text-lg sm:text-xl font-bold font-mono tabular-nums text-slate-900 mt-0.5">
                    {card.metricValue}
                  </div>
                  <div className="text-xs text-slate-600 mt-0.5 font-mono tabular-nums break-words">
                    {card.subMetrics}
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200/80 bg-white px-3 py-2 text-xs text-slate-700 leading-relaxed">
                <span className="font-bold text-blue-700 mr-1">한 줄 정리</span>
                {card.plainSummary}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
