import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Calculator,
  Check,
  CheckCircle2,
  Database,
  FileText,
  GitBranch,
  Grid3X3,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import Papa from 'papaparse';
import { PWAInstallButton } from './components/PWAInstallButton';
import { StatsErrorBoundary } from './components/StatsErrorBoundary';
import { NavigateOptions, useToast } from './components/ToastCenter';
import { StepComposites } from './components/steps/StepComposites';
import { StepCorrelation } from './components/steps/StepCorrelation';
import { StepFactorAnalysis } from './components/steps/StepFactorAnalysis';
import { StepRegression } from './components/steps/StepRegression';
import { StepReliability } from './components/steps/StepReliability';
import { StepReport } from './components/steps/StepReport';
import { StepUpload } from './components/steps/StepUpload';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import {
  AnalysisBundle,
  AnalysisOptions,
  ColumnProfile,
  ConstructMapping,
  DataRow,
  DatasetPreprocessingSummary,
  EFAConfig,
  HypothesisConfig,
  SaveStatus,
  StepIssue,
} from './types/stats';
import {
  applyRecommendedMatches,
  recommendColumnsForConstructs,
} from './utils/columnMatcher';
import {
  autoDetectConstructs,
  buildDatasetPreprocessingSummary,
  inspectWorkbookSheets,
  normalizeTabularData,
  parsePastedSurveyText,
  parseSurveyFile,
} from './utils/fileIO';
import {
  activateDatasetOnServer,
  createDatasetOnServer,
  DatasetRecord,
  DatasetScopedState,
  DatasetSummaryItem,
  DEFAULT_ANALYSIS_OPTIONS,
  fetchWorkspaceFromServer,
  generateDatasetId,
  loadWorkspaceV2,
  mergeConstructsWithBindings,
  saveDatasetStateToServer,
  saveModelToServer,
  saveWorkspaceV2,
  splitConstructsToMetaAndBindings,
  Step0SubTab,
  StepId,
} from './utils/modelStore';
import {
  classifyRuntimeError,
  PipelineStage,
  safeRunStage,
} from './utils/pipelineError';
import {
  applyConstructRoles,
  buildDefaultPaths,
  computeConstructMappingStatus,
  parsePathSources,
  syncModelOnConstructChange,
  validateResearchModel,
} from './utils/researchModel';
import {
  buildAnalysisAccuracyAudit,
  computeComposites,
  evaluateHypotheses,
  extractNumericColumn,
  profileColumns,
  runCorrelation,
  runEFAWithDiagnostics,
  runMediation,
  runModeration,
  runOLSWithDiagnostics,
  runReliability,
} from './utils/statistics';
import { verifyThesisSections } from './utils/thesisVerifier';
import { generateThesisSections } from './utils/thesisWriter';

const STEP_STAGE_MAP: Record<StepId, PipelineStage> = {
  0: 'upload',
  1: 'efa',
  2: 'reliability',
  3: 'composites',
  4: 'correlation',
  5: 'regression',
  6: 'thesis',
};

const STEPS: {
  id: StepId;
  label: string;
  shortLabel: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 0, label: '0. 개요 & 데이터 입력', shortLabel: '0. 데이터', icon: Database },
  { id: 1, label: '1. 요인분석 (타당성)', shortLabel: '1. 요인분석', icon: BarChart3 },
  { id: 2, label: '2. 신뢰도 분석 (α)', shortLabel: '2. 신뢰도', icon: ShieldCheck },
  { id: 3, label: '3. 변수 계산 (합변수)', shortLabel: '3. 합변수', icon: Calculator },
  { id: 4, label: '4. 상관분석', shortLabel: '4. 상관분석', icon: Grid3X3 },
  { id: 5, label: '5. 회귀 · 매개 · 조절', shortLabel: '5. 회귀·매개', icon: GitBranch },
  { id: 6, label: '6. 결과 요약 & 논문 작성', shortLabel: '6. 논문작성', icon: FileText },
];

function deriveDefaultHypothesis(constructs: ConstructMapping[]): HypothesisConfig {
  const names = constructs.filter((c) => c.items.length > 0).map((c) => c.name);
  let base: HypothesisConfig;
  if (names.length === 0) {
    base = { mediator: '', dependent: '', independents: [], controls: [] };
  } else if (names.length === 1) {
    base = { mediator: '', dependent: names[0], independents: [], controls: [] };
  } else if (names.length === 2) {
    base = { mediator: '', dependent: names[1], independents: [names[0]], controls: [] };
  } else {
    const mediator =
      names.find((n) => /심리|매개|capital|psy|mediat|^m$/i.test(n)) || names[1] || '';
    const dependent =
      names.find((n) => n !== mediator && /혁신|종속|성과|만족|outcome|innov|dep|^y$/i.test(n)) ||
      names.find((n) => n !== mediator && n === names[names.length - 1]) ||
      names.find((n) => n !== mediator) ||
      '';
    const independents = names.filter((n) => n !== mediator && n !== dependent);
    base = { mediator, dependent, independents, controls: [] };
  }
  return {
    ...base,
    paths: buildDefaultPaths(base, constructs),
  };
}

function runUnifiedPipeline(params: {
  datasetId: string;
  fileName: string;
  rawRowCount: number;
  targetRows: DataRow[];
  targetColumns: string[];
  targetConstructs: ConstructMapping[];
  targetHypothesis: HypothesisConfig;
  targetEfaConfig: EFAConfig;
  parseWarnings: string[];
  analysisOptions: AnalysisOptions;
}): AnalysisBundle | null {
  const {
    datasetId,
    fileName,
    rawRowCount,
    targetRows,
    targetColumns,
    targetConstructs,
    targetHypothesis,
    targetEfaConfig,
    parseWarnings,
    analysisOptions,
  } = params;

  if (!targetRows.length) return null;

  const colSet = new Set(targetColumns);
  const issues: StepIssue[] = parseWarnings.map((msg) => ({
    step: 'upload',
    severity: 'info',
    message: msg,
  }));

  const columnProfiles: ColumnProfile[] = safeRunStage(
    'upload',
    targetColumns,
    [],
    () => profileColumns(targetRows, targetColumns),
    issues
  );
  const numericColsCount = columnProfiles.filter((c) => c.kind === 'numeric').length;
  if (columnProfiles.length > 0 && numericColsCount === 0) {
    issues.push({
      step: 'upload',
      severity: 'error',
      constraint: '수치형 변수 없음',
      message: '데이터에서 통계 계산이 가능한 수치형 열을 찾지 못했습니다.',
      actionHint: '설문 응답 값이 숫자(예: 1~5점)로 저장된 파일인지 확인하세요.',
      variables: targetColumns,
    });
  }

  // Validate research model + linkage status BEFORE filtering to confirmed constructs
  const modelCheck = validateResearchModel(targetConstructs, targetHypothesis, targetColumns);
  for (const mIssue of modelCheck.issues) {
    const dup = issues.some(
      (existing) =>
        existing.step === mIssue.step &&
        existing.constraint === mIssue.constraint &&
        existing.message === mIssue.message
    );
    if (!dup) issues.push(mIssue);
  }

  // Only include constructs that are confirmed AND whose items all exist in the current dataset columns
  const confirmedConstructs = targetConstructs.filter(
    (c) =>
      c.confirmed !== false &&
      c.items.length > 0 &&
      c.items.every((it) => colSet.has(it))
  );

  if (!confirmedConstructs.length) {
    const emptyBundle: AnalysisBundle = {
      datasetId,
      timestamp: Date.now(),
      efa: null,
      reliability: [],
      composites: [],
      correlation: { names: [], matrix: [] },
      regressions: [],
      mediation: null,
      moderation: null,
      hypothesisVerifications: evaluateHypotheses(targetHypothesis, [], null, null, []),
      issues,
      columnProfiles,
    };
    emptyBundle.executionMeta = buildAnalysisAccuracyAudit({
      datasetId,
      fileName,
      rawRowCount,
      columns: targetColumns,
      constructs: targetConstructs,
      hypothesis: targetHypothesis,
      analysisOptions,
      bundle: emptyBundle,
    });
    return emptyBundle;
  }

  const allMappedItems = Array.from(new Set(confirmedConstructs.flatMap((c) => c.items)));
  const efaOut = safeRunStage(
    'efa',
    allMappedItems,
    { result: null, issues: [] },
    () =>
      runEFAWithDiagnostics(
        targetRows,
        {
          ...targetEfaConfig,
          items: allMappedItems,
        },
        {
          constructs: confirmedConstructs,
          missingPolicy: analysisOptions.missingPolicy,
        }
      ),
    issues
  );
  issues.push(...efaOut.issues);

  const reliability = safeRunStage(
    'reliability',
    allMappedItems,
    [],
    () =>
      runReliability(targetRows, confirmedConstructs, {
        missingPolicy: analysisOptions.missingPolicy,
      }),
    issues
  );
  for (const rel of reliability) {
    if (rel.nItems < 2) {
      issues.push({
        step: 'reliability',
        severity: 'info',
        constraint: '단일 문항 척도',
        message: `'${rel.constructName}'은(는) 단일 문항(1개)으로 구성되어 Cronbach’s α를 산출하지 않습니다.`,
        variables: rel.items,
      });
    } else if (rel.nValid < 2 || !Number.isFinite(rel.alpha)) {
      issues.push({
        step: 'reliability',
        severity: 'warning',
        constraint: '유효 표본(N) 부족 또는 분산 0',
        message: `'${rel.constructName}'의 유효 응답 케이스(N=${rel.nValid})가 부족하거나 응답 분산이 0이어서 신뢰도(α)를 계산할 수 없습니다.`,
        actionHint: '결측이 많은 문항이나 문자형 열이 포함되었는지 확인하세요.',
        variables: rel.items,
      });
    }
  }

  const composites = safeRunStage(
    'composites',
    allMappedItems,
    [],
    () =>
      computeComposites(targetRows, confirmedConstructs, {
        missingPolicy: analysisOptions.missingPolicy,
        compositeMethod: analysisOptions.compositeMethod,
      }),
    issues
  );
  for (const comp of composites) {
    if (comp.n === 0) {
      issues.push({
        step: 'composites',
        severity: 'error',
        constraint: '유효 수치 데이터 없음 (N=0)',
        message: `합변수 '${comp.name}합'에 유효한 수치 데이터가 없습니다(N=0).`,
        actionHint: '연결된 문항이 문자열·날짜·결측으로만 채워져 있지 않은지 확인하세요.',
        variables: comp.items,
      });
    }
  }

  const compositeNames = composites.map((c) => c.name);
  const correlation = safeRunStage(
    'correlation',
    compositeNames,
    { names: [], matrix: [] },
    () => runCorrelation(composites),
    issues
  );
  if (composites.length < 2) {
    issues.push({
      step: 'correlation',
      severity: 'info',
      constraint: '최소 구성개념 수 (≥ 2개) 미달',
      message: '상관분석 및 회귀분석을 수행하려면 최소 2개 이상의 구성개념이 필요합니다.',
      actionHint: '0단계 [구성개념 연결 · 매핑]에서 독립변수와 종속변수를 별도 구성개념으로 연결해 주세요.',
      variables: compositeNames,
    });
  }

  const getComp = (name: string) => composites.find((c) => c.name === name);
  const medComp = getComp(targetHypothesis.mediator);
  const depComp = getComp(targetHypothesis.dependent);
  const indepComps = targetHypothesis.independents
    .map((n) => getComp(n))
    .filter((c): c is NonNullable<typeof c> => !!c);

  // Control variables: support BOTH construct-based controls (via composite) and raw demographic columns
  const controlConstructNames = confirmedConstructs
    .filter((c) => c.role === 'control')
    .map((c) => c.name);
  const candidateControlNames = Array.from(
    new Set([...(targetHypothesis.controls ?? []), ...controlConstructNames])
  );
  const controlCols: { name: string; values: (number | null)[] }[] = [];
  for (const colName of candidateControlNames) {
    const compMatch = getComp(colName);
    if (compMatch) {
      controlCols.push({ name: colName, values: compMatch.values });
    } else if (colSet.has(colName) && targetRows.some((r) => r[colName] !== undefined)) {
      controlCols.push({
        name: colName,
        values: extractNumericColumn(targetRows, colName),
      });
    }
  }
  const controlNames = controlCols.map((c) => c.name);

  const regressions = [];
  let h1Reg = null;
  let h3Reg = null;

  if ((!depComp || !indepComps.length) && !issues.some((i) => i.constraint?.includes('미지정'))) {
    issues.push({
      step: 'regression',
      severity: 'warning',
      constraint: '독립(X) · 종속(Y) 변수 미지정 또는 미연결',
      message:
        '회귀분석을 실행하려면 연결 확정된 독립변수(X)와 종속변수(Y)가 각각 1개 이상 필요합니다.',
      actionHint: '0단계 [구성개념 연결 · 매핑]에서 독립변수(X)와 종속변수(Y)의 문항 연결을 확정해 주세요.',
      variables: compositeNames,
    });
  }

  if (medComp && indepComps.length) {
    const h1Vars = [medComp.name, ...indepComps.map((c) => c.name), ...controlNames];
    const h1Out = safeRunStage(
      'regression',
      h1Vars,
      { result: null },
      () =>
        runOLSWithDiagnostics(
          'H1',
          'H1',
          `${medComp.name} ← ${indepComps.map((c) => c.name).join(' + ')}`,
          medComp.name,
          medComp.values,
          [...controlCols, ...indepComps.map((c) => ({ name: c.name, values: c.values }))],
          controlNames
        ),
      issues
    );
    if (h1Out.result) {
      h1Reg = h1Out.result;
      regressions.push(h1Reg);
    } else if (h1Out.issue) {
      issues.push(h1Out.issue);
    }
  }

  if (depComp && medComp && depComp.name !== medComp.name) {
    const h2Vars = [depComp.name, medComp.name, ...controlNames];
    const h2Out = safeRunStage(
      'regression',
      h2Vars,
      { result: null },
      () =>
        runOLSWithDiagnostics(
          'H2',
          'H2',
          `${depComp.name} ← ${medComp.name}`,
          depComp.name,
          depComp.values,
          [...controlCols, { name: medComp.name, values: medComp.values }],
          controlNames
        ),
      issues
    );
    if (h2Out.result) {
      regressions.push(h2Out.result);
    } else if (h2Out.issue) {
      issues.push(h2Out.issue);
    }
  }

  if (depComp && indepComps.length) {
    const h3Vars = [depComp.name, ...indepComps.map((c) => c.name), ...controlNames];
    const h3Out = safeRunStage(
      'regression',
      h3Vars,
      { result: null },
      () =>
        runOLSWithDiagnostics(
          'H3',
          'H3',
          `${depComp.name} ← ${indepComps.map((c) => c.name).join(' + ')}`,
          depComp.name,
          depComp.values,
          [...controlCols, ...indepComps.map((c) => ({ name: c.name, values: c.values }))],
          controlNames
        ),
      issues
    );
    if (h3Out.result) {
      h3Reg = h3Out.result;
      regressions.push(h3Reg);
    } else if (h3Out.issue) {
      issues.push(h3Out.issue);
    }
  }

  // Also execute any additional custom research model paths not already represented in regressions
  const compNameSet = new Set(compositeNames);
  const coveredSignatures = new Set(
    regressions.map((r) => `${r.dependent}<-${[...r.independents].sort().join('+')}`)
  );
  for (const path of targetHypothesis.paths ?? []) {
    if (path.role === 'moderation') continue;
    const toComp = getComp(path.to);
    const sources = parsePathSources(path.from, compNameSet).filter((s) => s !== path.to);
    const fromComps = sources
      .map((s) => getComp(s))
      .filter((c): c is NonNullable<typeof c> => !!c);
    if (!toComp || !fromComps.length) continue;
    const sig = `${toComp.name}<-${[...fromComps.map((c) => c.name)].sort().join('+')}`;
    if (coveredSignatures.has(sig)) continue;
    coveredSignatures.add(sig);

    const customVars = [toComp.name, ...fromComps.map((c) => c.name), ...controlNames];
    const customOut = safeRunStage(
      'regression',
      customVars,
      { result: null },
      () =>
        runOLSWithDiagnostics(
          path.id,
          path.id,
          `${toComp.name} ← ${fromComps.map((c) => c.name).join(' + ')}`,
          toComp.name,
          toComp.values,
          [...controlCols, ...fromComps.map((c) => ({ name: c.name, values: c.values }))],
          controlNames
        ),
      issues
    );
    if (customOut.result) {
      regressions.push(customOut.result);
    } else if (customOut.issue) {
      issues.push(customOut.issue);
    }
  }

  const medVars = [
    ...indepComps.map((c) => c.name),
    ...(medComp ? [medComp.name] : []),
    ...(depComp ? [depComp.name] : []),
    ...controlNames,
  ];
  const mediation = safeRunStage(
    'mediation',
    medVars,
    null,
    () =>
      runMediation(
        composites,
        targetHypothesis,
        h1Reg,
        h3Reg,
        1000,
        controlCols
      ),
    issues
  );

  if (!mediation && indepComps.length > 0 && depComp) {
    if (!medComp || medComp.name === depComp.name) {
      issues.push({
        step: 'mediation',
        severity: 'info',
        constraint: '매개변수(M) 미지정',
        message: '매개효과 검정을 실행하려면 독립·종속변수와 구분되는 매개변수(M)를 선택해야 합니다.',
        actionHint: '0단계 [변수 매핑 · 모형 설정]에서 매개변수(M)를 별도로 지정하면 Baron & Kenny · Sobel · Bootstrap 검증이 자동 실행됩니다.',
      });
    } else if (!issues.some((i) => i.step === 'mediation' && i.severity === 'error')) {
      issues.push({
        step: 'mediation',
        severity: 'warning',
        constraint: '4단계 회귀 추정 불가 (표본 부족 / 다중공선성)',
        message: '유효 표본 수 부족 또는 다중공선성으로 인해 4단계 매개검증 회귀식을 추정하지 못했습니다.',
        variables: medVars,
      });
    }
  }

  let moderation = null;
  if (
    targetHypothesis.moderationX &&
    targetHypothesis.moderator &&
    targetHypothesis.moderationY
  ) {
    const mx = getComp(targetHypothesis.moderationX);
    const mw = getComp(targetHypothesis.moderator);
    const my = getComp(targetHypothesis.moderationY);
    if (mx && mw && my) {
      const modVars = [mx.name, mw.name, my.name, ...controlNames];
      moderation = safeRunStage(
        'moderation',
        modVars,
        null,
        () =>
          runModeration(
            mx.name,
            mx.values,
            mw.name,
            mw.values,
            my.name,
            my.values,
            controlCols
          ),
        issues
      );
      if (!moderation && !issues.some((i) => i.step === 'moderation' && i.severity === 'error')) {
        issues.push({
          step: 'moderation',
          severity: 'warning',
          constraint: '표본 부족 또는 변수 중복·상수',
          message:
            '조절효과 검증에 필요한 유효 표본 수가 부족하거나 선택한 변수(X, W, Y)가 중복·상수입니다.',
          variables: modVars,
        });
      }
    }
  }

  const hypothesisVerifications = evaluateHypotheses(
    targetHypothesis,
    regressions,
    mediation,
    moderation,
    confirmedConstructs.map((c) => c.name)
  );

  const partialBundle: AnalysisBundle = {
    datasetId,
    timestamp: Date.now(),
    efa: efaOut.result,
    reliability,
    composites,
    correlation,
    regressions,
    mediation,
    moderation,
    hypothesisVerifications,
    issues,
    columnProfiles,
  };

  partialBundle.executionMeta = buildAnalysisAccuracyAudit({
    datasetId,
    fileName,
    rawRowCount,
    columns: targetColumns,
    constructs: targetConstructs,
    hypothesis: targetHypothesis,
    analysisOptions,
    bundle: partialBundle,
  });

  return partialBundle;
}

export default function App() {
  const isOnline = useOnlineStatus();
  const initialLocal = useMemo(() => loadWorkspaceV2(), []);
  const initialActiveDs = useMemo(() => {
    if (!initialLocal?.activeDatasetId) return null;
    return initialLocal.datasets[initialLocal.activeDatasetId] ?? null;
  }, [initialLocal]);
  const initialActiveState = useMemo(() => {
    if (!initialLocal?.activeDatasetId) return null;
    return initialLocal.datasetStates[initialLocal.activeDatasetId] ?? null;
  }, [initialLocal]);
  const initialConstructs = useMemo(() => {
    if (!initialLocal?.model.constructsMeta.length) return [];
    return mergeConstructsWithBindings(
      initialLocal.model.constructsMeta,
      initialActiveState?.bindings ?? {},
      initialActiveDs?.columns ?? [],
      initialLocal.model.hypothesis
    );
  }, [initialLocal, initialActiveState, initialActiveDs]);

  const hasInitialLocalData = Boolean(
    initialActiveDs && (initialActiveDs.rows.length > 0 || initialConstructs.length > 0)
  );

  const [activeDatasetId, setActiveDatasetId] = useState<string>(
    initialActiveDs?.datasetId ?? initialLocal?.activeDatasetId ?? ''
  );
  const [datasetsMap, setDatasetsMap] = useState<Record<string, DatasetRecord>>(
    initialLocal?.datasets ?? {}
  );
  const [datasetStatesMap, setDatasetStatesMap] = useState<Record<string, DatasetScopedState>>(
    initialLocal?.datasetStates ?? {}
  );
  const [datasetList, setDatasetList] = useState<DatasetSummaryItem[]>(() =>
    Object.values(initialLocal?.datasets ?? {}).map((ds) => ({
      datasetId: ds.datasetId,
      fileName: ds.fileName,
      sheetName: ds.sheetName,
      headerRowIndex: ds.headerRowIndex,
      rowCount: ds.rows.length,
      colCount: ds.columns.length,
      createdAt: ds.createdAt,
      updatedAt: ds.updatedAt,
    }))
  );

  const [modelSource, setModelSource] = useState<'sample' | 'user'>(
    initialLocal?.model.modelSource ?? 'sample'
  );

  const [activeStep, setActiveStep] = useState<StepId>(initialActiveState?.activeStep ?? 0);
  const [step0Tab, setStep0Tab] = useState<Step0SubTab>(
    initialActiveState?.step0Tab ?? 'overview'
  );
  const [highlightVariables, setHighlightVariables] = useState(false);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [completedSteps, setCompletedSteps] = useState<Set<StepId>>(
    () => new Set([0, initialActiveState?.activeStep ?? 0])
  );

  const [fileName, setFileName] = useState<string>(initialActiveDs?.fileName ?? '');
  const [sheetName, setSheetName] = useState<string | undefined>(initialActiveDs?.sheetName);
  const [availableSheets, setAvailableSheets] = useState<string[]>(
    initialActiveDs?.preprocessing?.availableSheets ?? []
  );
  const [headerRowIndex, setHeaderRowIndex] = useState<number>(
    initialActiveDs?.headerRowIndex ?? 0
  );
  const [rawRowCount, setRawRowCount] = useState<number>(
    initialActiveDs?.preprocessing?.rawRowCount ?? initialActiveDs?.rows.length ?? 0
  );
  const [duplicateRowCount, setDuplicateRowCount] = useState<number>(
    initialActiveDs?.preprocessing?.duplicateRowCount ?? 0
  );
  const [duplicateColumns, setDuplicateColumns] = useState<string[]>(
    initialActiveDs?.preprocessing?.duplicateColumns ?? []
  );
  const [rows, setRows] = useState<DataRow[]>(initialActiveDs?.rows ?? []);
  const [columns, setColumns] = useState<string[]>(initialActiveDs?.columns ?? []);
  const [parseWarnings, setParseWarnings] = useState<string[]>(
    initialActiveDs?.parseWarnings ?? []
  );
  const [preprocessing, setPreprocessing] = useState<DatasetPreprocessingSummary | null>(
    initialActiveDs?.preprocessing ?? null
  );

  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [constructs, setConstructs] = useState<ConstructMapping[]>(initialConstructs);
  const [hypothesis, setHypothesis] = useState<HypothesisConfig>(
    initialLocal?.model.hypothesis ?? {
      modelName: '',
      mediator: '',
      dependent: '',
      independents: [],
      controls: [],
      paths: [],
    }
  );
  const [efaConfig, setEfaConfig] = useState<EFAConfig>(
    initialActiveState?.efaConfig ?? {
      items: [],
      extractionMode: 'kaiser',
      fixedFactors: 6,
      loadingThreshold: 0.5,
      sortBySize: true,
    }
  );
  const [analysisOptions, setAnalysisOptions] = useState<AnalysisOptions>(
    initialActiveState?.analysisOptions ?? { ...DEFAULT_ANALYSIS_OPTIONS }
  );

  const [pendingMatchConfirmation, setPendingMatchConfirmation] = useState<boolean>(() =>
    initialConstructs.some((c) => c.confirmed === false)
  );
  const [bundle, setBundle] = useState<AnalysisBundle | null>(null);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const modelRevisionRef = useRef<number>(initialLocal?.model.revision ?? 1);
  const datasetRevisionRef = useRef<number>(initialActiveState?.revision ?? 1);
  const lastSyncedModelSigRef = useRef<string>('');
  const lastSyncedStateSigRef = useRef<string>('');
  const isHydratedRef = useRef<boolean>(false);
  const lastUploadedFileRef = useRef<{ datasetId: string; file: File } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { pushToast, notifyIssues, registerNavigate } = useToast();

  const triggerVariableHighlight = useCallback(() => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightVariables(true);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightVariables(false);
    }, 3200);
  }, []);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const navigateToStep = useCallback(
    (nextStep: StepId, markCurrentDone = false, opts?: NavigateOptions) => {
      setActiveStep((prev) => {
        if (markCurrentDone) {
          setCompletedSteps((doneSet) => {
            const nextSet = new Set(doneSet);
            nextSet.add(prev);
            return nextSet;
          });
        }
        return nextStep;
      });
      if (nextStep === 0 && opts?.step0Tab) {
        setStep0Tab(opts.step0Tab);
      }
      if (nextStep === 0 && opts?.highlightVariables) {
        setTimeout(() => triggerVariableHighlight(), 60);
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    },
    [triggerVariableHighlight]
  );

  useEffect(() => {
    registerNavigate((stepIndex, opts) => {
      navigateToStep(stepIndex, false, opts);
    });
  }, [registerNavigate, navigateToStep]);

  // Warn before closing tab if auto-save is pending or failed
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (saveStatus === 'saving' || saveStatus === 'error') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveStatus]);

  // Helper to apply a DatasetRecord + DatasetScopedState + ResearchModel into active React state
  const hydrateActiveWorkspaceState = useCallback(
    (params: {
      model: {
        constructsMeta: ReturnType<typeof splitConstructsToMetaAndBindings>['constructsMeta'];
        hypothesis: HypothesisConfig;
        modelSource: 'sample' | 'user';
        revision: number;
      };
      dataset: DatasetRecord;
      state: DatasetScopedState | null;
      allDatasetsList?: DatasetSummaryItem[];
    }) => {
      const { model, dataset, state, allDatasetsList } = params;
      const mergedConstructs = mergeConstructsWithBindings(
        model.constructsMeta,
        state?.bindings ?? {},
        dataset.columns,
        model.hypothesis
      );
      const nextOpts = state?.analysisOptions ?? { ...DEFAULT_ANALYSIS_OPTIONS };
      const prep =
        dataset.preprocessing ??
        buildDatasetPreprocessingSummary({
          datasetId: dataset.datasetId,
          fileName: dataset.fileName,
          sheetName: dataset.sheetName,
          headerRowIndex: dataset.headerRowIndex,
          rawRowCount: dataset.rows.length,
          rows: dataset.rows,
          columns: dataset.columns,
          outlierZThreshold: nextOpts.outlierZThreshold,
        });

      const nextEfa: EFAConfig = state?.efaConfig ?? {
        items: Array.from(new Set(mergedConstructs.flatMap((c) => c.items))),
        extractionMode: 'kaiser',
        fixedFactors: Math.max(1, mergedConstructs.length),
        loadingThreshold: 0.5,
        sortBySize: true,
      };

      modelRevisionRef.current = model.revision || 1;
      datasetRevisionRef.current = state?.revision ?? 1;

      setActiveDatasetId(dataset.datasetId);
      setFileName(dataset.fileName);
      setSheetName(dataset.sheetName);
      setAvailableSheets(prep.availableSheets ?? []);
      setHeaderRowIndex(dataset.headerRowIndex ?? 0);
      setRawRowCount(prep.rawRowCount ?? dataset.rows.length);
      setDuplicateRowCount(prep.duplicateRowCount ?? 0);
      setDuplicateColumns(prep.duplicateColumns ?? []);
      setRows(dataset.rows);
      setColumns(dataset.columns);
      setParseWarnings(dataset.parseWarnings ?? []);
      setPreprocessing(prep);
      setModelSource(model.modelSource);
      setConstructs(mergedConstructs);
      setHypothesis(model.hypothesis);
      setAnalysisOptions(nextOpts);
      setEfaConfig(nextEfa);
      setActiveStep(state?.activeStep ?? 0);
      setStep0Tab(state?.step0Tab ?? 'overview');
      setPendingMatchConfirmation(mergedConstructs.some((c) => c.confirmed === false));
      setBundle(null);

      setDatasetsMap((prev) => ({ ...prev, [dataset.datasetId]: dataset }));
      if (state) {
        setDatasetStatesMap((prev) => ({ ...prev, [dataset.datasetId]: state }));
      }
      if (allDatasetsList) {
        setDatasetList(allDatasetsList);
      }

      const { constructsMeta, bindings } = splitConstructsToMetaAndBindings(mergedConstructs);
      lastSyncedModelSigRef.current = JSON.stringify({
        constructsMeta,
        hypothesis: model.hypothesis,
        modelSource: model.modelSource,
      });
      lastSyncedStateSigRef.current = JSON.stringify({
        datasetId: dataset.datasetId,
        bindings,
        analysisOptions: nextOpts,
        efaConfig: nextEfa,
        activeStep: state?.activeStep ?? 0,
        step0Tab: state?.step0Tab ?? 'overview',
      });
    },
    []
  );

  const initializeDataset = useCallback(
    async (params: {
      loadedRows: DataRow[];
      loadedCols: string[];
      name: string;
      warnings?: string[];
      sheetName?: string;
      availableSheets?: string[];
      headerRowIndex?: number;
      rawRowCount?: number;
      duplicateRowCount?: number;
      duplicateColumns?: string[];
      isSample?: boolean;
      preserveUserModel?: boolean;
      uploadedFile?: File;
    }) => {
      const {
        loadedRows,
        loadedCols,
        name,
        warnings = [],
        sheetName: nextSheet,
        availableSheets: nextSheets = [],
        headerRowIndex: nextHeaderIdx = 0,
        rawRowCount: nextRawCount = loadedRows.length,
        duplicateRowCount: nextDupRows = 0,
        duplicateColumns: nextDupCols = [],
        isSample = false,
        preserveUserModel = false,
        uploadedFile,
      } = params;

      const newDatasetId = generateDatasetId(isSample ? 'sample' : 'ds');
      const now = Date.now();
      const profiles = profileColumns(loadedRows, loadedCols);
      const prep = buildDatasetPreprocessingSummary({
        datasetId: newDatasetId,
        fileName: name,
        sheetName: nextSheet,
        availableSheets: nextSheets,
        headerRowIndex: nextHeaderIdx,
        rawRowCount: nextRawCount,
        rows: loadedRows,
        columns: loadedCols,
        profiles,
        duplicateRowCount: nextDupRows,
        duplicateColumns: nextDupCols,
        outlierZThreshold: analysisOptions.outlierZThreshold,
      });

      let nextConstructs: ConstructMapping[];
      let nextHyp: HypothesisConfig;
      let nextModelSource: 'sample' | 'user';
      let nextStep0Tab: Step0SubTab = 'overview';
      let nextActiveStep: StepId = 0;
      let nextPendingConfirm = false;

      if (preserveUserModel && constructs.length > 0) {
        // Core Rule: Keep registered constructs & hypotheses, wipe prior confirmed bindings,
        // generate candidate recommendations ONLY (never auto-confirm solely on similar names).
        const recommended = recommendColumnsForConstructs(constructs, loadedCols, profiles, {
          preserveExistingConfirmed: false,
        });
        nextHyp = hypothesis;
        nextConstructs = recommended.map((c) => ({
          ...c,
          mappingStatus: computeConstructMappingStatus(c, loadedCols, nextHyp),
        }));
        nextModelSource = 'user';
        nextStep0Tab = 'mapping';
        nextActiveStep = 0;
        nextPendingConfirm = true;
      } else {
        const detected = autoDetectConstructs(loadedCols, loadedRows);
        nextHyp = deriveDefaultHypothesis(detected);
        const withMeta = detected.map((c) => ({
          ...c,
          surveyItemIds: [...c.items],
          confirmed: true,
        }));
        nextConstructs = applyConstructRoles(withMeta, nextHyp, loadedCols);
        nextModelSource = isSample ? 'sample' : 'user';
        nextStep0Tab = 'overview';
        nextPendingConfirm = false;
      }

      const allItems = Array.from(
        new Set(
          nextConstructs
            .filter((c) => c.confirmed !== false)
            .flatMap((c) => c.items)
        )
      );
      const nextEfa: EFAConfig = {
        items: allItems,
        extractionMode: 'kaiser',
        fixedFactors: Math.max(1, nextConstructs.length),
        loadingThreshold: efaConfig.loadingThreshold || 0.5,
        sortBySize: true,
      };

      const { constructsMeta, bindings } = splitConstructsToMetaAndBindings(nextConstructs);

      const newDatasetRecord: DatasetRecord = {
        datasetId: newDatasetId,
        fileName: name,
        sheetName: nextSheet,
        headerRowIndex: nextHeaderIdx,
        columns: loadedCols,
        rows: loadedRows,
        parseWarnings: warnings,
        preprocessing: prep,
        createdAt: now,
        updatedAt: now,
      };
      const newScopedState: DatasetScopedState = {
        datasetId: newDatasetId,
        bindings,
        analysisOptions: { ...analysisOptions },
        efaConfig: nextEfa,
        activeStep: nextActiveStep,
        step0Tab: nextStep0Tab,
        bundle: null,
        revision: 1,
        updatedAt: now,
      };

      if (uploadedFile) {
        lastUploadedFileRef.current = { datasetId: newDatasetId, file: uploadedFile };
      } else {
        lastUploadedFileRef.current = null;
      }

      // Immediately clear prior bundle so zero stale results remain visible
      setBundle(null);
      setActiveDatasetId(newDatasetId);
      setRows(loadedRows);
      setColumns(loadedCols);
      setFileName(name);
      setSheetName(nextSheet);
      setAvailableSheets(nextSheets);
      setHeaderRowIndex(nextHeaderIdx);
      setRawRowCount(nextRawCount);
      setDuplicateRowCount(nextDupRows);
      setDuplicateColumns(nextDupCols);
      setParseWarnings(warnings);
      setPreprocessing(prep);
      setErrorMsg(null);
      setCompletedSteps(new Set([0]));
      setModelSource(nextModelSource);
      setConstructs(nextConstructs);
      setHypothesis(nextHyp);
      setEfaConfig(nextEfa);
      setStep0Tab(nextStep0Tab);
      setActiveStep(nextActiveStep);
      setPendingMatchConfirmation(nextPendingConfirm);

      setDatasetsMap((prev) => ({ ...prev, [newDatasetId]: newDatasetRecord }));
      setDatasetStatesMap((prev) => ({ ...prev, [newDatasetId]: newScopedState }));
      setDatasetList((prev) => [
        {
          datasetId: newDatasetId,
          fileName: name,
          sheetName: nextSheet,
          headerRowIndex: nextHeaderIdx,
          rowCount: loadedRows.length,
          colCount: loadedCols.length,
          createdAt: now,
          updatedAt: now,
        },
        ...prev.filter((d) => d.datasetId !== newDatasetId),
      ]);

      // Persist immediately to SQLite backend
      setSaveStatus('saving');
      const [modelRes, dsRes] = await Promise.all([
        saveModelToServer({
          constructsMeta,
          hypothesis: nextHyp,
          modelSource: nextModelSource,
          expectedRevision: modelRevisionRef.current,
        }),
        createDatasetOnServer({
          dataset: newDatasetRecord,
          state: {
            datasetId: newDatasetId,
            bindings,
            analysisOptions: { ...analysisOptions },
            efaConfig: nextEfa,
            activeStep: nextActiveStep,
            step0Tab: nextStep0Tab,
            bundle: null,
          },
        }),
      ]);

      if (modelRes.ok && modelRes.revision) {
        modelRevisionRef.current = modelRes.revision;
      } else if (modelRes.conflict && modelRes.currentRevision) {
        const retry = await saveModelToServer({
          constructsMeta,
          hypothesis: nextHyp,
          modelSource: nextModelSource,
          expectedRevision: modelRes.currentRevision,
        });
        if (retry.ok && retry.revision) modelRevisionRef.current = retry.revision;
      }

      if (dsRes.ok && dsRes.revision) {
        datasetRevisionRef.current = dsRes.revision;
      }

      lastSyncedModelSigRef.current = JSON.stringify({
        constructsMeta,
        hypothesis: nextHyp,
        modelSource: nextModelSource,
      });
      lastSyncedStateSigRef.current = JSON.stringify({
        datasetId: newDatasetId,
        bindings,
        analysisOptions,
        efaConfig: nextEfa,
        activeStep: nextActiveStep,
        step0Tab: nextStep0Tab,
      });

      if (dsRes.ok) {
        setSaveStatus('saved');
        setLastSavedAt(Date.now());
        setSaveError(null);
      } else {
        setSaveStatus('error');
        setSaveError(dsRes.error || '서버 저장 실패');
      }

      if (nextPendingConfirm) {
        pushToast({
          severity: 'warning',
          title: '새 데이터셋 업로드 · 문항 연결 확인 필요',
          constraint: '기존 연구모형 구성개념 유지됨',
          message: `등록된 ${nextConstructs.length}개 구성개념을 새 데이터(${name})의 컬럼과 매칭해 추천했습니다. [구성개념 연결 관리표]에서 검토 후 확정해 주세요.`,
          stepIndex: 0,
        });
      }
    },
    [analysisOptions, constructs, efaConfig.loadingThreshold, hypothesis, pushToast]
  );

  const handleLoadSample = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/assets/aistudio/data_items_2b48a8f0.csv');
      if (!res.ok) throw new Error('샘플 CSV 파일을 불러오지 못했습니다.');
      const text = (await res.text()).replace(/^\uFEFF/, '');
      const parsed = Papa.parse<unknown[]>(text, {
        header: false,
        skipEmptyLines: 'greedy',
      });
      const normalized = normalizeTabularData(parsed.data || []);
      if (!normalized.rows.length || !normalized.columns.length) {
        throw new Error('샘플 데이터에서 유효한 행과 변수명을 찾지 못했습니다.');
      }
      await initializeDataset({
        loadedRows: normalized.rows,
        loadedCols: normalized.columns,
        name: '매개효과test (기본 샘플)',
        warnings: normalized.warnings,
        headerRowIndex: normalized.headerRowIndex,
        rawRowCount: normalized.rawRowCount,
        duplicateRowCount: normalized.duplicateRowCount,
        duplicateColumns: normalized.duplicateColumns,
        isSample: true,
        preserveUserModel: false,
      });
    } catch (err) {
      console.error('[SPSS 연구통계] 샘플 데이터 로드 실패:', err);
      const msg = err instanceof Error ? err.message : '샘플 데이터 로드 실패';
      setErrorMsg(msg);
      pushToast({
        severity: 'error',
        title: '샘플 데이터 로드 오류',
        constraint: '파일 불러오기 실패',
        message: msg,
        stepIndex: 0,
      });
    } finally {
      setIsLoading(false);
    }
  }, [initializeDataset, pushToast]);

  // Hydrate from SQLite backend first, falling back to localStorage or sample dataset
  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      const serverWs = await fetchWorkspaceFromServer();
      if (cancelled) return;

      if (serverWs && serverWs.activeDataset && serverWs.model) {
        hydrateActiveWorkspaceState({
          model: serverWs.model,
          dataset: serverWs.activeDataset,
          state: serverWs.activeState,
          allDatasetsList: serverWs.datasets,
        });
        isHydratedRef.current = true;
        setIsLoading(false);
        return;
      }

      if (hasInitialLocalData && initialLocal && initialActiveDs) {
        // Push local workspace into SQLite so server stays in sync
        isHydratedRef.current = true;
        setIsLoading(false);
        const { constructsMeta, bindings } = splitConstructsToMetaAndBindings(initialConstructs);
        await saveModelToServer({
          constructsMeta,
          hypothesis: initialLocal.model.hypothesis,
          modelSource: initialLocal.model.modelSource,
        });
        await createDatasetOnServer({
          dataset: initialActiveDs,
          state: {
            datasetId: initialActiveDs.datasetId,
            bindings,
            analysisOptions: initialActiveState?.analysisOptions ?? { ...DEFAULT_ANALYSIS_OPTIONS },
            efaConfig: initialActiveState?.efaConfig ?? efaConfig,
            activeStep: initialActiveState?.activeStep ?? 0,
            step0Tab: initialActiveState?.step0Tab ?? 'overview',
            bundle: null,
          },
        });
        return;
      }

      isHydratedRef.current = true;
      await handleLoadSample();
    }
    void hydrate();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reactive unified calculation: guarantees ANY change to dataset, constructs, hypothesis,
  // efaConfig, or analysisOptions immediately clears/recomputes bundle with zero stale leakage.
  useEffect(() => {
    if (!rows.length || !activeDatasetId) {
      setBundle(null);
      notifyIssues([]);
      return;
    }
    try {
      const nextBundle = runUnifiedPipeline({
        datasetId: activeDatasetId,
        fileName,
        rawRowCount: rawRowCount || rows.length,
        targetRows: rows,
        targetColumns: columns,
        targetConstructs: constructs,
        targetHypothesis: hypothesis,
        targetEfaConfig: efaConfig,
        parseWarnings,
        analysisOptions,
      });
      setBundle(nextBundle);
    } catch (err) {
      const issue = classifyRuntimeError(
        err,
        'regression',
        constructs.map((c) => c.name)
      );
      console.error('[SPSS 연구통계] 파이프라인 전역 런타임 오류:', err);
      setBundle({
        datasetId: activeDatasetId,
        timestamp: Date.now(),
        efa: null,
        reliability: [],
        composites: [],
        correlation: { names: [], matrix: [] },
        regressions: [],
        mediation: null,
        moderation: null,
        issues: [issue],
      });
    }
  }, [
    activeDatasetId,
    fileName,
    rawRowCount,
    rows,
    columns,
    constructs,
    hypothesis,
    efaConfig,
    parseWarnings,
    analysisOptions,
    notifyIssues,
  ]);

  // Sync preprocessing outlier summary when threshold changes
  useEffect(() => {
    if (!rows.length || !activeDatasetId) return;
    setPreprocessing(
      buildDatasetPreprocessingSummary({
        datasetId: activeDatasetId,
        fileName,
        sheetName,
        availableSheets,
        headerRowIndex,
        rawRowCount: rawRowCount || rows.length,
        rows,
        columns,
        duplicateRowCount,
        duplicateColumns,
        outlierZThreshold: analysisOptions.outlierZThreshold,
      })
    );
  }, [
    activeDatasetId,
    fileName,
    sheetName,
    availableSheets,
    headerRowIndex,
    rawRowCount,
    duplicateRowCount,
    duplicateColumns,
    rows,
    columns,
    analysisOptions.outlierZThreshold,
  ]);

  // Execute actual server + localStorage save helper (also usable for manual retry)
  const flushSaveToServer = useCallback(async () => {
    if (!activeDatasetId) return;
    const { constructsMeta, bindings } = splitConstructsToMetaAndBindings(constructs);
    const modelPayload = {
      constructsMeta,
      hypothesis,
      modelSource,
    };
    const modelSig = JSON.stringify(modelPayload);
    const statePayload = {
      datasetId: activeDatasetId,
      bindings,
      analysisOptions,
      efaConfig,
      activeStep,
      step0Tab,
    };
    const stateSig = JSON.stringify(statePayload);

    const modelDirty = modelSig !== lastSyncedModelSigRef.current;
    const stateDirty = stateSig !== lastSyncedStateSigRef.current || bundle !== null;

    if (!modelDirty && !stateDirty) {
      setSaveStatus('saved');
      return;
    }

    setSaveStatus('saving');
    let allOk = true;
    let errDetail: string | null = null;

    if (modelDirty) {
      let res = await saveModelToServer({
        ...modelPayload,
        expectedRevision: modelRevisionRef.current,
      });
      if (res.conflict && res.currentRevision) {
        res = await saveModelToServer({
          ...modelPayload,
          expectedRevision: res.currentRevision,
        });
      }
      if (res.ok && res.revision) {
        modelRevisionRef.current = res.revision;
        lastSyncedModelSigRef.current = modelSig;
      } else {
        allOk = false;
        errDetail = res.error || '연구모형 저장 실패';
      }
    }

    if (stateDirty) {
      let res = await saveDatasetStateToServer(activeDatasetId, {
        bindings,
        analysisOptions,
        efaConfig,
        activeStep,
        step0Tab,
        bundle,
        expectedRevision: datasetRevisionRef.current,
      });
      if (res.conflict && res.currentRevision) {
        res = await saveDatasetStateToServer(activeDatasetId, {
          bindings,
          analysisOptions,
          efaConfig,
          activeStep,
          step0Tab,
          bundle,
          expectedRevision: res.currentRevision,
        });
      }
      if (!res.ok && res.error?.includes('찾을 수 없습니다')) {
        // Recover if dataset hasn't been created on server yet
        const now = Date.now();
        const dsRecord: DatasetRecord = datasetsMap[activeDatasetId] ?? {
          datasetId: activeDatasetId,
          fileName,
          sheetName,
          headerRowIndex,
          columns,
          rows,
          parseWarnings,
          preprocessing,
          createdAt: now,
          updatedAt: now,
        };
        const created = await createDatasetOnServer({
          dataset: dsRecord,
          state: {
            datasetId: activeDatasetId,
            bindings,
            analysisOptions,
            efaConfig,
            activeStep,
            step0Tab,
            bundle,
          },
        });
        if (created.ok && created.revision) {
          res = { ok: true, revision: created.revision };
        }
      }
      if (res.ok && res.revision) {
        datasetRevisionRef.current = res.revision;
        lastSyncedStateSigRef.current = stateSig;
      } else {
        allOk = false;
        errDetail = res.error || '분석 상태 저장 실패';
      }
    }

    if (allOk) {
      setSaveStatus('saved');
      setLastSavedAt(Date.now());
      setSaveError(null);
    } else {
      setSaveStatus('error');
      setSaveError(errDetail);
    }
  }, [
    activeDatasetId,
    activeStep,
    analysisOptions,
    bundle,
    columns,
    constructs,
    datasetsMap,
    efaConfig,
    fileName,
    headerRowIndex,
    hypothesis,
    modelSource,
    parseWarnings,
    preprocessing,
    rows,
    sheetName,
    step0Tab,
  ]);

  // Debounced auto-save to localStorage (immediate) + SQLite DB (450ms)
  useEffect(() => {
    if (!isHydratedRef.current || !activeDatasetId || isLoading) return;
    const now = Date.now();
    const { constructsMeta, bindings } = splitConstructsToMetaAndBindings(constructs);

    const activeDatasetRecord: DatasetRecord = {
      datasetId: activeDatasetId,
      fileName,
      sheetName,
      headerRowIndex,
      columns,
      rows,
      parseWarnings,
      preprocessing,
      createdAt: datasetsMap[activeDatasetId]?.createdAt ?? now,
      updatedAt: now,
    };
    const activeScopedState: DatasetScopedState = {
      datasetId: activeDatasetId,
      bindings,
      analysisOptions,
      efaConfig,
      activeStep,
      step0Tab,
      bundle,
      revision: datasetRevisionRef.current,
      updatedAt: now,
    };

    const nextDatasetsMap = { ...datasetsMap, [activeDatasetId]: activeDatasetRecord };
    const nextStatesMap = { ...datasetStatesMap, [activeDatasetId]: activeScopedState };

    saveWorkspaceV2({
      version: 2,
      savedAt: now,
      activeDatasetId,
      model: {
        constructsMeta,
        hypothesis,
        modelSource,
        revision: modelRevisionRef.current,
        updatedAt: now,
      },
      datasets: nextDatasetsMap,
      datasetStates: nextStatesMap,
    });

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus('saving');
    saveTimerRef.current = setTimeout(() => {
      void flushSaveToServer();
    }, 450);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeDatasetId,
    fileName,
    sheetName,
    headerRowIndex,
    columns,
    rows,
    parseWarnings,
    constructs,
    hypothesis,
    modelSource,
    efaConfig,
    analysisOptions,
    activeStep,
    step0Tab,
    bundle,
    isLoading,
  ]);

  const handleFileUpload = async (file: File) => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const sheets = await inspectWorkbookSheets(file);
      const {
        rows: parsedRows,
        columns: parsedCols,
        fileName: parsedName,
        warnings,
        sheetName: usedSheet,
        availableSheets: wbSheets,
        headerRowIndex: detectedHeaderIdx,
        rawRowCount: parsedRawCount,
        duplicateRowCount: dupRows,
        duplicateColumns: dupCols,
      } = await parseSurveyFile(file);

      if (!parsedRows.length || !parsedCols.length) {
        const msg =
          '업로드한 파일에서 유효한 데이터 행 또는 변수명(헤더)을 찾을 수 없습니다. 빈 시트나 제목만 있는 파일인지 확인해 주세요.';
        console.error('[SPSS 연구통계] 파일 파싱 결과 비어 있음:', { fileName: file.name, warnings });
        setErrorMsg(msg);
        pushToast({
          severity: 'error',
          title: '0. 데이터 입력 오류',
          constraint: '유효 데이터/헤더 누락',
          message: msg,
          actionHint: '첫 행에 변수명이 있고 3행 이상의 응답 데이터가 포함된 파일인지 확인하세요.',
          stepIndex: 0,
        });
        return;
      }
      if (parsedRows.length < 3) {
        const msg = `데이터 행이 ${parsedRows.length}행뿐입니다. 통계 분석을 수행하려면 헤더 외 최소 3행 이상의 응답 데이터가 필요합니다.`;
        console.warn('[SPSS 연구통계] 표본 수 부족:', { fileName: file.name, rows: parsedRows.length });
        setErrorMsg(msg);
        pushToast({
          severity: 'warning',
          title: '0. 데이터 입력 제한',
          constraint: `최소 표본 수(N ≥ 3) 미달`,
          message: msg,
          stepIndex: 0,
        });
        return;
      }

      const shouldPreserveUserModel = modelSource === 'user' && constructs.length > 0;
      await initializeDataset({
        loadedRows: parsedRows,
        loadedCols: parsedCols,
        name: parsedName,
        warnings,
        sheetName: usedSheet,
        availableSheets: wbSheets ?? sheets,
        headerRowIndex: detectedHeaderIdx,
        rawRowCount: parsedRawCount,
        duplicateRowCount: dupRows,
        duplicateColumns: dupCols,
        isSample: false,
        preserveUserModel: shouldPreserveUserModel,
        uploadedFile: file,
      });
    } catch (err) {
      console.error('[SPSS 연구통계] 파일 업로드 파싱 오류:', file.name, err);
      const msg =
        err instanceof Error
          ? `파일(${file.name})을 읽는 중 오류가 발생했습니다: ${err.message}`
          : '파일을 읽는 중 오류가 발생했습니다.';
      setErrorMsg(msg);
      pushToast({
        severity: 'error',
        title: '0. 파일 파싱 오류',
        constraint: '파일 형식 / 인코딩 오류',
        message: msg,
        actionHint: 'CSV(UTF-8/EUC-KR), Excel(.xlsx/.xls), JSON 형식인지 확인해 주세요.',
        stepIndex: 0,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleReParseExcel = async (opts: { sheetName?: string; headerRowIndex?: number }) => {
    const fileRef = lastUploadedFileRef.current;
    if (!fileRef || fileRef.datasetId !== activeDatasetId) return;
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const parsed = await parseSurveyFile(fileRef.file, opts);
      if (!parsed.rows.length || !parsed.columns.length) {
        pushToast({
          severity: 'warning',
          title: '시트/헤더 변경 결과 비어 있음',
          message: '선택한 시트 또는 헤더 행 기준 유효한 데이터가 없습니다.',
          stepIndex: 0,
        });
        return;
      }

      const profiles = profileColumns(parsed.rows, parsed.columns);
      const nextSheet = parsed.sheetName;
      const nextHeader = parsed.headerRowIndex;
      const prep = buildDatasetPreprocessingSummary({
        datasetId: activeDatasetId,
        fileName: parsed.fileName,
        sheetName: nextSheet,
        availableSheets: parsed.availableSheets,
        headerRowIndex: nextHeader,
        rawRowCount: parsed.rawRowCount,
        rows: parsed.rows,
        columns: parsed.columns,
        profiles,
        duplicateRowCount: parsed.duplicateRowCount,
        duplicateColumns: parsed.duplicateColumns,
        outlierZThreshold: analysisOptions.outlierZThreshold,
      });

      const updatedConstructs = recommendColumnsForConstructs(
        constructs,
        parsed.columns,
        profiles,
        { preserveExistingConfirmed: true }
      ).map((c) => ({
        ...c,
        mappingStatus: computeConstructMappingStatus(c, parsed.columns, hypothesis),
      }));

      setBundle(null);
      setRows(parsed.rows);
      setColumns(parsed.columns);
      setSheetName(nextSheet);
      setAvailableSheets(parsed.availableSheets ?? []);
      setHeaderRowIndex(nextHeader);
      setRawRowCount(parsed.rawRowCount);
      setDuplicateRowCount(parsed.duplicateRowCount);
      setDuplicateColumns(parsed.duplicateColumns);
      setParseWarnings(parsed.warnings);
      setPreprocessing(prep);
      setConstructs(updatedConstructs);
      setPendingMatchConfirmation(updatedConstructs.some((c) => c.confirmed === false));

      const { bindings } = splitConstructsToMetaAndBindings(updatedConstructs);
      const now = Date.now();
      const updatedRecord: DatasetRecord = {
        datasetId: activeDatasetId,
        fileName: parsed.fileName,
        sheetName: nextSheet,
        headerRowIndex: nextHeader,
        columns: parsed.columns,
        rows: parsed.rows,
        parseWarnings: parsed.warnings,
        preprocessing: prep,
        createdAt: datasetsMap[activeDatasetId]?.createdAt ?? now,
        updatedAt: now,
      };
      setDatasetsMap((prev) => ({ ...prev, [activeDatasetId]: updatedRecord }));
      await createDatasetOnServer({
        dataset: updatedRecord,
        state: {
          datasetId: activeDatasetId,
          bindings,
          analysisOptions,
          efaConfig,
          activeStep,
          step0Tab,
          bundle: null,
        },
      });
    } catch (err) {
      pushToast({
        severity: 'error',
        title: '시트/헤더 재해석 실패',
        message: err instanceof Error ? err.message : '파일을 다시 읽지 못했습니다.',
        stepIndex: 0,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasteData = async (rawText: string) => {
    setErrorMsg(null);
    try {
      const {
        rows: parsedRows,
        columns: parsedCols,
        warnings,
        headerRowIndex: detectedHeaderIdx,
        rawRowCount: parsedRawCount,
        duplicateRowCount: dupRows,
        duplicateColumns: dupCols,
      } = parsePastedSurveyText(rawText);
      if (parsedRows.length < 3 || parsedCols.length < 2) {
        const msg = `붙여넣은 데이터에서 충분한 행(현재 ${parsedRows.length}행, 최소 3행 필요)과 변수 열(현재 ${parsedCols.length}열, 최소 2열 필요)을 찾지 못했습니다. 첫 행에 변수명을 포함해 주세요.`;
        console.warn('[SPSS 연구통계] 붙여넣기 데이터 형식 부족:', {
          rows: parsedRows.length,
          cols: parsedCols.length,
        });
        setErrorMsg(msg);
        pushToast({
          severity: 'warning',
          title: '0. 붙여넣기 데이터 부족',
          constraint: '최소 행(≥3) · 열(≥2) 미달',
          message: msg,
          stepIndex: 0,
        });
        return;
      }
      const shouldPreserveUserModel = modelSource === 'user' && constructs.length > 0;
      await initializeDataset({
        loadedRows: parsedRows,
        loadedCols: parsedCols,
        name: '직접 붙여넣기 입력 데이터',
        warnings,
        headerRowIndex: detectedHeaderIdx,
        rawRowCount: parsedRawCount,
        duplicateRowCount: dupRows,
        duplicateColumns: dupCols,
        isSample: false,
        preserveUserModel: shouldPreserveUserModel,
      });
    } catch (err) {
      console.error('[SPSS 연구통계] 붙여넣기 파싱 오류:', err);
      const msg =
        err instanceof Error
          ? `붙여넣은 데이터를 해석하는 중 오류가 발생했습니다: ${err.message}`
          : '붙여넣은 데이터를 해석하는 중 오류가 발생했습니다.';
      setErrorMsg(msg);
      pushToast({
        severity: 'error',
        title: '0. 붙여넣기 해석 오류',
        constraint: '표 구분자 / 형식 오류',
        message: msg,
        stepIndex: 0,
      });
    }
  };

  const handleSelectDataset = async (targetDatasetId: string) => {
    if (!targetDatasetId || targetDatasetId === activeDatasetId) return;
    setIsLoading(true);
    try {
      const serverAct = await activateDatasetOnServer(targetDatasetId);
      if (serverAct.ok && serverAct.dataset) {
        const { constructsMeta } = splitConstructsToMetaAndBindings(constructs);
        hydrateActiveWorkspaceState({
          model: {
            constructsMeta,
            hypothesis,
            modelSource,
            revision: modelRevisionRef.current,
          },
          dataset: serverAct.dataset,
          state: serverAct.state ?? null,
        });
        return;
      }

      const localDs = datasetsMap[targetDatasetId];
      if (localDs) {
        const { constructsMeta } = splitConstructsToMetaAndBindings(constructs);
        hydrateActiveWorkspaceState({
          model: {
            constructsMeta,
            hypothesis,
            modelSource,
            revision: modelRevisionRef.current,
          },
          dataset: localDs,
          state: datasetStatesMap[targetDatasetId] ?? null,
        });
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangeConstructs = useCallback(
    (nextConstructs: ConstructMapping[]) => {
      const synced = syncModelOnConstructChange(constructs, nextConstructs, hypothesis, columns);
      setModelSource('user');
      setConstructs(synced.constructs);
      setHypothesis(synced.hypothesis);
      setPendingMatchConfirmation(synced.constructs.some((c) => c.confirmed === false));
      const nextItems = Array.from(
        new Set(
          synced.constructs
            .filter((c) => c.confirmed !== false)
            .flatMap((c) => c.items)
        )
      );
      setEfaConfig((prev) => ({
        ...prev,
        items: nextItems,
      }));
    },
    [constructs, hypothesis, columns]
  );

  const handleChangeHypothesis = useCallback((nextHyp: HypothesisConfig) => {
    setModelSource('user');
    setHypothesis(nextHyp);
  }, []);

  const handleSaveResearchModel = useCallback(
    (
      nextConstructs: ConstructMapping[],
      nextHypothesis: HypothesisConfig,
      options?: { showToast?: boolean; nextTab?: 'overview' | 'mapping' }
    ) => {
      const synced = syncModelOnConstructChange(constructs, nextConstructs, nextHypothesis, columns);
      setModelSource('user');
      setConstructs(synced.constructs);
      setHypothesis(synced.hypothesis);
      setPendingMatchConfirmation(synced.constructs.some((c) => c.confirmed === false));
      const nextItems = Array.from(
        new Set(
          synced.constructs
            .filter((c) => c.confirmed !== false)
            .flatMap((c) => c.items)
        )
      );
      setEfaConfig((prev) => ({
        ...prev,
        items: nextItems,
        fixedFactors: Math.max(1, synced.constructs.length),
      }));
      if (options?.nextTab) {
        setStep0Tab(options.nextTab);
      }
      if (options?.showToast) {
        pushToast({
          severity: 'success',
          title: '연구모형 저장 완료',
          message: `구성개념 ${synced.constructs.length}개 · 가설 ${synced.hypothesis.paths?.length ?? 0}개가 저장되어 전체 분석 단계에 반영되었습니다.`,
          stepIndex: 5,
        });
      }
    },
    [constructs, columns, pushToast]
  );

  const handleConfirmRecommended = useCallback(
    (constructId: string, selectedItems: string[]) => {
      const next = constructs.map((c) => {
        if (c.id !== constructId) return c;
        const sorted = [...selectedItems].sort((a, b) =>
          a.localeCompare(b, 'ko', { numeric: true })
        );
        const updated: ConstructMapping = {
          ...c,
          items: sorted,
          reverseItems: (c.reverseItems ?? []).filter((r) => sorted.includes(r)),
          missingMatchedItems: [],
          confirmed: sorted.length > 0,
        };
        return {
          ...updated,
          mappingStatus: computeConstructMappingStatus(updated, columns, hypothesis),
        };
      });
      setModelSource('user');
      setConstructs(next);
      setPendingMatchConfirmation(next.some((c) => c.confirmed === false));
      const confirmedItems = Array.from(
        new Set(next.filter((c) => c.confirmed !== false).flatMap((c) => c.items))
      );
      setEfaConfig((prev) => ({ ...prev, items: confirmedItems }));
    },
    [constructs, columns, hypothesis]
  );

  const handleConfirmAllRecommended = useCallback(() => {
    const applied = applyRecommendedMatches(constructs).map((c) => ({
      ...c,
      mappingStatus: computeConstructMappingStatus(c, columns, hypothesis),
    }));
    setModelSource('user');
    setConstructs(applied);
    setPendingMatchConfirmation(applied.some((c) => c.confirmed === false));
    const confirmedItems = Array.from(
      new Set(applied.filter((c) => c.confirmed !== false).flatMap((c) => c.items))
    );
    setEfaConfig((prev) => ({ ...prev, items: confirmedItems }));
    pushToast({
      severity: 'success',
      title: '추천 문항 일괄 연결 확정',
      message: '추천된 설문 문항을 실제 구성개념에 확정 반영하고 전체 통계 분석을 갱신했습니다.',
    });
  }, [constructs, columns, hypothesis, pushToast]);

  const handleRebuildFromColumns = useCallback(() => {
    const detected = autoDetectConstructs(columns, rows);
    const hyp = deriveDefaultHypothesis(detected);
    const roled = applyConstructRoles(
      detected.map((c) => ({ ...c, surveyItemIds: [...c.items], confirmed: true })),
      hyp,
      columns
    );
    const allItems = Array.from(new Set(roled.flatMap((c) => c.items)));
    setModelSource('user');
    setConstructs(roled);
    setHypothesis(hyp);
    setPendingMatchConfirmation(false);
    setEfaConfig((prev) => ({
      ...prev,
      items: allItems,
      fixedFactors: Math.max(1, roled.length),
    }));
    pushToast({
      severity: 'info',
      title: '현재 파일 기준 구성개념 재구성 완료',
      message: `업로드된 컬럼에서 ${roled.length}개 구성개념을 자동 감지하여 새로 구성했습니다.`,
    });
  }, [columns, rows, pushToast]);

  const handleRunAnalysis = () => {
    if (!rows.length) {
      setErrorMsg('분석할 설문 데이터가 없습니다. 먼저 파일을 업로드하거나 데이터를 붙여넣어 주세요.');
      navigateToStep(0);
      return;
    }
    const unconfirmedOrEmpty = constructs.filter(
      (c) => c.confirmed === false || c.items.length === 0
    );
    if (unconfirmedOrEmpty.length > 0) {
      setStep0Tab('mapping');
      setActiveStep(0);
      triggerVariableHighlight();
      pushToast({
        severity: 'warning',
        title: '구성개념 문항 연결 확정 필요',
        constraint: `${unconfirmedOrEmpty.length}개 구성개념 미연결/미확정`,
        message: `[${unconfirmedOrEmpty.map((c) => c.name).join(', ')}]의 설문 문항을 연결·확정한 뒤 분석을 진행해 주세요.`,
        stepIndex: 0,
      });
      return;
    }
    setCompletedSteps(new Set([0]));
    navigateToStep(1, true);
  };

  const handleRunRegression = () => {
    if (!rows.length) {
      pushToast({
        severity: 'warning',
        title: '5. 회귀분석 실행 불가',
        constraint: '설문 데이터 없음',
        message: '먼저 0단계에서 설문 데이터 파일을 업로드하거나 붙여넣어 주세요.',
        stepIndex: 0,
      });
      return;
    }
    const nextBundle = runUnifiedPipeline({
      datasetId: activeDatasetId || generateDatasetId('ds'),
      fileName,
      rawRowCount: rawRowCount || rows.length,
      targetRows: rows,
      targetColumns: columns,
      targetConstructs: constructs,
      targetHypothesis: hypothesis,
      targetEfaConfig: efaConfig,
      parseWarnings,
      analysisOptions,
    });
    setBundle(nextBundle);
    if (nextBundle && nextBundle.regressions.length > 0) {
      pushToast({
        severity: 'success',
        title: '5. 회귀분석 실행 완료',
        message: `선택한 변수(X: ${hypothesis.independents.join(', ')} → Y: ${hypothesis.dependent})로 ${nextBundle.regressions.length}개 회귀 모형을 산출했습니다.`,
      });
    }
  };

  const handleUpdateEfaConfig = (next: EFAConfig) => {
    setEfaConfig(next);
  };

  const handleUpdateModeration = (x?: string, w?: string, y?: string) => {
    setModelSource('user');
    setHypothesis((prev) => ({
      ...prev,
      moderationX: x,
      moderator: w,
      moderationY: y,
    }));
  };

  const { thesisSections, thesisIssue } = useMemo(() => {
    if (!bundle) {
      return {
        thesisSections: [] as ReturnType<typeof generateThesisSections>,
        thesisIssue: null as StepIssue | null,
      };
    }
    const modelVars = Array.from(
      new Set([
        ...hypothesis.independents,
        ...(hypothesis.mediator ? [hypothesis.mediator] : []),
        ...(hypothesis.dependent ? [hypothesis.dependent] : []),
        ...hypothesis.controls,
      ])
    );
    const thesisIssues: StepIssue[] = [];
    const sections = safeRunStage(
      'thesis',
      modelVars,
      [] as ReturnType<typeof generateThesisSections>,
      () => generateThesisSections(bundle, hypothesis),
      thesisIssues
    );
    return {
      thesisSections: sections,
      thesisIssue: thesisIssues[0] ?? null,
    };
  }, [bundle, hypothesis]);

  const effectiveBundle = useMemo(() => {
    if (!bundle) return null;
    if (!thesisIssue) return bundle;
    return {
      ...bundle,
      issues: [...(bundle.issues ?? []), thesisIssue],
    };
  }, [bundle, thesisIssue]);

  useEffect(() => {
    notifyIssues(effectiveBundle?.issues ?? []);
  }, [effectiveBundle, notifyIssues]);

  const activeStageVars = useMemo(() => {
    if (activeStep === 1) return efaConfig.items;
    if (activeStep === 2 || activeStep === 3 || activeStep === 4) {
      return constructs
        .filter((c) => c.confirmed !== false && c.items.length > 0)
        .map((c) => c.name);
    }
    if (activeStep === 5 || activeStep === 6) {
      return Array.from(
        new Set([
          ...hypothesis.independents,
          ...(hypothesis.mediator ? [hypothesis.mediator] : []),
          ...(hypothesis.dependent ? [hypothesis.dependent] : []),
          ...hypothesis.controls,
        ])
      );
    }
    return columns;
  }, [activeStep, efaConfig.items, constructs, hypothesis, columns]);

  const verificationBySection = useMemo(() => {
    if (!effectiveBundle || !thesisSections.length) return {};
    const report = verifyThesisSections({
      rows,
      constructs,
      hypothesis,
      efaConfig,
      bundle: effectiveBundle,
      sections: thesisSections,
      style: 'standard',
      analysisOptions,
    });
    return Object.fromEntries(report.sectionResults.map((r) => [r.sectionId, r]));
  }, [rows, constructs, hypothesis, efaConfig, effectiveBundle, thesisSections, analysisOptions]);

  const efaRelThesis = useMemo(
    () => thesisSections.find((s) => s.id === 'efa_rel'),
    [thesisSections]
  );
  const descCorrThesis = useMemo(
    () => thesisSections.find((s) => s.id === 'desc_corr'),
    [thesisSections]
  );
  const regThesis = useMemo(
    () => thesisSections.find((s) => s.id === 'regression'),
    [thesisSections]
  );
  const medThesis = useMemo(
    () => thesisSections.find((s) => s.id === 'mediation'),
    [thesisSections]
  );
  const modThesis = useMemo(
    () => thesisSections.find((s) => s.id === 'moderation'),
    [thesisSections]
  );

  const datasetStatusText = useMemo(() => {
    if (isLoading && !rows.length) return '데이터 불러오는 중...';
    if (!rows.length) return '데이터 대기 중';
    return `N = ${rows.length} · 변수 ${columns.length}개`;
  }, [isLoading, rows.length, columns.length]);

  const progressText = useMemo(() => {
    return `${completedSteps.size} / ${STEPS.length}단계 확인`;
  }, [completedSteps.size]);

  const formattedSavedTime = useMemo(() => {
    if (!lastSavedAt) return '';
    return new Date(lastSavedAt).toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }, [lastSavedAt]);

  const canReparseFile = Boolean(
    lastUploadedFileRef.current && lastUploadedFileRef.current.datasetId === activeDatasetId
  );

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="bg-white/95 backdrop-blur-md border-b border-slate-200/90 sticky top-0 z-30 no-print">
        <div className="max-w-[1440px] mx-auto px-3 sm:px-6 h-[60px] sm:h-[68px] flex items-center justify-between gap-3 lg:gap-8">
          {/* Zone 1: Single wordmark */}
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              navigateToStep(0);
            }}
            className="inline-flex items-center gap-2 text-base sm:text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            <span className="inline-flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-slate-900 text-white text-xs font-mono font-bold tracking-tighter shadow-sm">
              S
            </span>
            <span>SPSS 연구통계</span>
          </a>

          {/* Zone 2: 5 concise single-line nav links (lg+ paired cleanly with <lg step bar) */}
          <nav className="hidden lg:flex items-center gap-7 text-sm font-medium text-slate-600">
            <button
              type="button"
              onClick={() => navigateToStep(0)}
              className={`hover:text-slate-900 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer py-2 border-b-2 ${
                activeStep === 0
                  ? 'text-blue-700 font-semibold border-blue-700'
                  : 'border-transparent'
              }`}
            >
              개요·데이터
            </button>
            <button
              type="button"
              onClick={() => navigateToStep(1)}
              className={`hover:text-slate-900 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer py-2 border-b-2 ${
                activeStep === 1
                  ? 'text-blue-700 font-semibold border-blue-700'
                  : 'border-transparent'
              }`}
            >
              요인분석
            </button>
            <button
              type="button"
              onClick={() => navigateToStep(2)}
              className={`hover:text-slate-900 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer py-2 border-b-2 ${
                activeStep === 2 || activeStep === 3
                  ? 'text-blue-700 font-semibold border-blue-700'
                  : 'border-transparent'
              }`}
            >
              신뢰도·변수계산
            </button>
            <button
              type="button"
              onClick={() => navigateToStep(4)}
              className={`hover:text-slate-900 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer py-2 border-b-2 ${
                activeStep === 4 || activeStep === 5
                  ? 'text-blue-700 font-semibold border-blue-700'
                  : 'border-transparent'
              }`}
            >
              상관·회귀분석
            </button>
            <button
              type="button"
              onClick={() => navigateToStep(6)}
              className={`hover:text-slate-900 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer py-2 border-b-2 ${
                activeStep === 6
                  ? 'text-blue-700 font-semibold border-blue-700'
                  : 'border-transparent'
              }`}
            >
              결과·논문작성
            </button>
          </nav>

          {/* Zone 3: Auto-save status indicator + primary action */}
          <div className="flex items-center gap-2.5 shrink-0">
            {saveStatus === 'saving' && (
              <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500 whitespace-nowrap">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" />
                저장 중...
              </span>
            )}
            {saveStatus === 'saved' && (
              <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 whitespace-nowrap">
                <Check className="w-3.5 h-3.5" />
                저장 완료{formattedSavedTime ? ` · ${formattedSavedTime}` : ''}
              </span>
            )}
            {saveStatus === 'error' && (
              <button
                type="button"
                onClick={() => void flushSaveToServer()}
                title={saveError || '서버 저장 실패'}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-50 border border-red-200 text-[11px] font-semibold text-red-700 hover:bg-red-100 cursor-pointer whitespace-nowrap"
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>저장 실패 · 다시 저장</span>
                <RefreshCw className="w-3 h-3" />
              </button>
            )}

            {rows.length > 0 ? (
              <button
                type="button"
                onClick={handleRunAnalysis}
                className="px-3 sm:px-4 py-2 min-h-[40px] text-xs font-semibold text-white bg-blue-700 rounded-xl shadow-sm hover:bg-blue-800 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span className="sm:hidden">순서대로 시작</span>
                <span className="hidden sm:inline">1단계부터 순서대로 시작</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleLoadSample()}
                disabled={isLoading}
                className="px-3 sm:px-4 py-2 min-h-[40px] text-xs font-semibold text-white bg-slate-900 rounded-xl shadow-sm hover:bg-slate-800 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                매개효과test 불러오기
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Mobile & Tablet horizontal step switcher */}
      <div className="lg:hidden bg-white border-b border-slate-200 px-3 sm:px-6 py-2 overflow-x-auto no-print">
        <div className="flex items-center gap-1.5 sm:gap-2">
          {STEPS.map((step) => {
            const active = activeStep === step.id;
            return (
              <button
                key={step.id}
                type="button"
                onClick={() => navigateToStep(step.id)}
                className={`px-3 sm:px-3.5 py-2 min-h-[40px] rounded-xl text-xs font-semibold whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                  active
                    ? 'bg-slate-900 text-white shadow-sm'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200/80'
                }`}
              >
                {step.shortLabel}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Workspace */}
      <div className="flex-1 max-w-[1440px] w-full mx-auto px-3 sm:px-6 py-4 sm:py-8 grid grid-cols-1 lg:grid-cols-12 gap-5 lg:gap-7 min-w-0">
        {/* Desktop Left Sidebar */}
        <aside className="hidden lg:block lg:col-span-3 no-print">
          <div className="sticky top-24 space-y-5">
            <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_16px_-4px_rgba(15,23,42,0.03)] space-y-3.5">
              <div className="flex items-center justify-between px-1">
                <span className="text-xs font-bold text-slate-600">SPSS 분석 절차</span>
                <span className="text-xs font-mono tabular-nums text-blue-700 font-bold">
                  {progressText}
                </span>
              </div>
              <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-700 transition-all duration-300"
                  style={{ width: `${Math.round((completedSteps.size / STEPS.length) * 100)}%` }}
                />
              </div>
              <nav className="space-y-1 pt-1" aria-label="통계 분석 단계">
                {STEPS.map((step) => {
                  const Icon = step.icon;
                  const active = activeStep === step.id;
                  const done = completedSteps.has(step.id) && bundle !== null;
                  return (
                    <button
                      key={step.id}
                      type="button"
                      onClick={() => navigateToStep(step.id)}
                      className={`w-full flex items-center justify-between gap-2 px-3.5 py-2.5 min-h-[42px] rounded-xl text-xs font-semibold transition-colors duration-150 cursor-pointer ${
                        active
                          ? 'bg-slate-900 text-white shadow-sm'
                          : 'text-slate-700 hover:bg-slate-100/90 hover:text-slate-900'
                      }`}
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-blue-300' : 'text-slate-400'}`} />
                        <span className="truncate">{step.label}</span>
                      </span>
                      {done && !active && (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      )}
                    </button>
                  );
                })}
              </nav>
            </div>

            <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_16px_-4px_rgba(15,23,42,0.03)] space-y-2 text-xs text-slate-600">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-900">현재 작업 상태</span>
                {activeDatasetId && (
                  <span className="text-[10px] font-mono text-slate-400 truncate max-w-[110px]" title={activeDatasetId}>
                    {activeDatasetId}
                  </span>
                )}
              </div>
              <div className="font-mono tabular-nums text-slate-800 font-semibold">{datasetStatusText}</div>
              {fileName && <div className="truncate text-slate-500" title={fileName}>{fileName}</div>}
              {pendingMatchConfirmation && (
                <div className="pt-2 border-t border-slate-100 text-amber-700 font-semibold">
                  새 데이터셋 문항 연결 확정 대기 중
                </div>
              )}
              {bundle && !pendingMatchConfirmation && bundle.composites.length > 0 && (
                <div className="pt-2 border-t border-slate-100 text-emerald-700 font-semibold">
                  전체 분석 · 논문 문장 준비됨
                </div>
              )}
            </div>

            <PWAInstallButton />
          </div>
        </aside>

        {/* Main Viewport protected by step-scoped StatsErrorBoundary */}
        <main className="lg:col-span-9 min-w-0">
          <StatsErrorBoundary
            stage={STEP_STAGE_MAP[activeStep]}
            variables={activeStageVars}
            resetKey={`${activeStep}-${activeDatasetId}-${bundle?.timestamp ?? 0}`}
            onGoToData={() => navigateToStep(0)}
          >
            {activeStep === 0 && (
              <StepUpload
                datasetId={activeDatasetId}
                fileName={fileName}
                rows={rows}
                columns={columns}
                isLoading={isLoading}
                errorMsg={errorMsg}
                constructs={constructs}
                hypothesis={hypothesis}
                efaConfig={efaConfig}
                bundle={bundle}
                activeSubTab={step0Tab}
                highlightVariables={highlightVariables}
                preprocessing={preprocessing}
                availableSheets={availableSheets}
                sheetName={sheetName}
                headerRowIndex={headerRowIndex}
                canReparseFile={canReparseFile}
                availableDatasets={datasetList}
                analysisOptions={analysisOptions}
                pendingMatchConfirmation={pendingMatchConfirmation}
                onChangeSubTab={setStep0Tab}
                onChangeConstructs={handleChangeConstructs}
                onChangeHypothesis={handleChangeHypothesis}
                onSaveResearchModel={handleSaveResearchModel}
                onChangeEFAConfig={setEfaConfig}
                onChangeAnalysisOptions={setAnalysisOptions}
                onAutoDetect={handleRebuildFromColumns}
                onConfirmRecommended={handleConfirmRecommended}
                onConfirmAllRecommended={handleConfirmAllRecommended}
                onFileUpload={handleFileUpload}
                onPasteData={handlePasteData}
                onReParseExcel={handleReParseExcel}
                onSelectDataset={handleSelectDataset}
                onLoadSample={handleLoadSample}
                onRunAnalysis={handleRunAnalysis}
                onNext={() => navigateToStep(1, true)}
              />
            )}

            {activeStep === 1 && (
              <StepFactorAnalysis
                efa={bundle?.efa ?? null}
                efaConfig={efaConfig}
                issues={bundle?.issues?.filter((i) => i.step === 'efa' || i.step === 'mapping') ?? []}
                thesisSection={efaRelThesis}
                thesisVerification={verificationBySection['efa_rel']}
                onUpdateConfig={handleUpdateEfaConfig}
                onPrev={() => navigateToStep(0)}
                onNext={() => navigateToStep(2, true)}
              />
            )}

            {activeStep === 2 && (
              <StepReliability
                rows={bundle?.reliability ?? []}
                issues={bundle?.issues?.filter((i) => i.step === 'reliability' || i.step === 'mapping') ?? []}
                thesisSection={efaRelThesis}
                thesisVerification={verificationBySection['efa_rel']}
                onPrev={() => navigateToStep(1)}
                onNext={() => navigateToStep(3, true)}
              />
            )}

            {activeStep === 3 && (
              <StepComposites
                composites={bundle?.composites ?? []}
                issues={bundle?.issues?.filter((i) => i.step === 'composites' || i.step === 'mapping') ?? []}
                thesisSection={descCorrThesis}
                thesisVerification={verificationBySection['desc_corr']}
                onPrev={() => navigateToStep(2)}
                onNext={() => navigateToStep(4, true)}
              />
            )}

            {activeStep === 4 && (
              <StepCorrelation
                correlation={bundle?.correlation ?? { names: [], matrix: [] }}
                composites={bundle?.composites ?? []}
                issues={bundle?.issues?.filter((i) => i.step === 'correlation' || i.step === 'mapping') ?? []}
                thesisSection={descCorrThesis}
                thesisVerification={verificationBySection['desc_corr']}
                onPrev={() => navigateToStep(3)}
                onNext={() => navigateToStep(5, true)}
              />
            )}

            {activeStep === 5 && (
              <StepRegression
                regressions={bundle?.regressions ?? []}
                mediation={bundle?.mediation ?? null}
                moderation={bundle?.moderation ?? null}
                composites={bundle?.composites ?? []}
                hypothesis={hypothesis}
                hypothesisVerifications={bundle?.hypothesisVerifications}
                issues={
                  bundle?.issues?.filter(
                    (i) =>
                      i.step === 'regression' ||
                      i.step === 'mediation' ||
                      i.step === 'moderation' ||
                      i.step === 'mapping'
                  ) ?? []
                }
                regressionThesis={regThesis}
                mediationThesis={medThesis}
                moderationThesis={modThesis}
                regressionVerification={verificationBySection['regression']}
                mediationVerification={verificationBySection['mediation']}
                moderationVerification={verificationBySection['moderation']}
                onUpdateModeration={handleUpdateModeration}
                onGoToMapping={() =>
                  navigateToStep(0, false, { step0Tab: 'mapping', highlightVariables: true })
                }
                onRunRegression={handleRunRegression}
                onPrev={() => navigateToStep(4)}
                onNext={() => navigateToStep(6, true)}
              />
            )}

            {activeStep === 6 && (
              <StepReport
                bundle={effectiveBundle}
                fileName={fileName}
                rows={rows}
                constructs={constructs}
                hypothesis={hypothesis}
                efaConfig={efaConfig}
                analysisOptions={analysisOptions}
                thesisSections={thesisSections}
                onPrev={() => navigateToStep(5)}
                onResetToStart={() => navigateToStep(0, true)}
              />
            )}
          </StatsErrorBoundary>
        </main>
      </div>

      {/* Offline indicator */}
      {!isOnline && (
        <div className="fixed bottom-4 left-4 z-50 rounded-xl bg-amber-600 px-4 py-2.5 text-xs font-medium text-white shadow-lg no-print">
          오프라인 모드 · 모든 통계 연산과 논문 문장 작성이 브라우저 내부에서 정상 작동합니다.
        </div>
      )}

      <footer className="border-t border-slate-200/80 bg-white py-5 px-4 text-center text-xs text-slate-500 no-print">
        SPSS 연구통계 · 데이터 입력 → 통계분석 → 결과표 읽기 → 논문 본문 문장 작성 · 모든 데이터는 연구 DB에 자동 저장됩니다.
      </footer>
    </div>
  );
}
