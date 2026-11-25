import {
  AnalysisBundle,
  AnalysisOptions,
  ConstructMapping,
  ConstructRole,
  DataRow,
  DatasetPreprocessingSummary,
  EFAConfig,
  HypothesisConfig,
  RecommendedItemMatch,
  ScaleType,
  VerificationHistoryEntry,
  VerificationReportSummary,
} from '../types/stats';
import { computeConstructMappingStatus } from './researchModel';

export const WORKSPACE_STORAGE_KEY = 'spss_research_stats_workspace_v2';
export const LEGACY_WORKSPACE_STORAGE_KEY = 'spss_research_stats_workspace_v1';
export const VERIFICATION_STORAGE_KEY = 'spss_research_stats_verification_v1';

export type StepId = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type Step0SubTab = 'overview' | 'model' | 'mapping';

export const DEFAULT_ANALYSIS_OPTIONS: AnalysisOptions = {
  missingPolicy: 'pairwise',
  compositeMethod: 'mean',
  outlierZThreshold: 3.29,
};

export interface ConstructModelMeta {
  id: string;
  name: string;
  role?: ConstructRole;
  scaleType?: ScaleType;
  scaleMin?: number;
  scaleMax?: number;
  surveyItemIds?: string[];
}

export interface ConstructDatasetBinding {
  items: string[];
  reverseItems: string[];
  recommendedItems?: RecommendedItemMatch[];
  missingMatchedItems?: string[];
  confirmed: boolean;
}

export interface DatasetRecord {
  datasetId: string;
  fileName: string;
  sheetName?: string;
  headerRowIndex: number;
  columns: string[];
  rows: DataRow[];
  parseWarnings: string[];
  preprocessing: DatasetPreprocessingSummary | null;
  createdAt: number;
  updatedAt: number;
}

export interface DatasetSummaryItem {
  datasetId: string;
  fileName: string;
  sheetName?: string;
  headerRowIndex: number;
  rowCount: number;
  colCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface DatasetScopedState {
  datasetId: string;
  bindings: Record<string, ConstructDatasetBinding>;
  analysisOptions: AnalysisOptions;
  efaConfig: EFAConfig;
  activeStep: StepId;
  step0Tab: Step0SubTab;
  bundle?: AnalysisBundle | null;
  thesisEdits?: Record<string, string>;
  revision: number;
  updatedAt: number;
}

export interface ResearchModelRecord {
  constructsMeta: ConstructModelMeta[];
  hypothesis: HypothesisConfig;
  modelSource: 'sample' | 'user';
  revision: number;
  updatedAt: number;
}

export interface PersistedWorkspaceV2 {
  version: 2;
  savedAt: number;
  activeDatasetId: string | null;
  model: ResearchModelRecord;
  datasets: Record<string, DatasetRecord>;
  datasetStates: Record<string, DatasetScopedState>;
}

export function generateDatasetId(prefix = 'ds'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function splitConstructsToMetaAndBindings(constructs: ConstructMapping[]): {
  constructsMeta: ConstructModelMeta[];
  bindings: Record<string, ConstructDatasetBinding>;
} {
  const constructsMeta: ConstructModelMeta[] = [];
  const bindings: Record<string, ConstructDatasetBinding> = {};
  for (const c of constructs) {
    constructsMeta.push({
      id: c.id,
      name: c.name,
      role: c.role,
      scaleType: c.scaleType ?? 'likert5',
      scaleMin: c.scaleMin,
      scaleMax: c.scaleMax,
      surveyItemIds: c.surveyItemIds,
    });
    bindings[c.id] = {
      items: [...c.items],
      reverseItems: [...(c.reverseItems ?? [])],
      recommendedItems: c.recommendedItems,
      missingMatchedItems: c.missingMatchedItems,
      confirmed: c.confirmed ?? (c.items.length > 0),
    };
  }
  return { constructsMeta, bindings };
}

export function mergeConstructsWithBindings(
  constructsMeta: ConstructModelMeta[],
  bindings: Record<string, ConstructDatasetBinding>,
  columns: string[] = [],
  hypothesis?: HypothesisConfig
): ConstructMapping[] {
  return constructsMeta.map((meta) => {
    const binding = bindings[meta.id];
    const items = binding ? [...binding.items] : [];
    const reverseItems = binding ? [...(binding.reverseItems ?? [])] : [];
    const merged: ConstructMapping = {
      id: meta.id,
      name: meta.name,
      role: meta.role,
      scaleType: meta.scaleType ?? 'likert5',
      scaleMin: meta.scaleMin,
      scaleMax: meta.scaleMax,
      surveyItemIds: meta.surveyItemIds,
      items,
      reverseItems,
      recommendedItems: binding?.recommendedItems,
      missingMatchedItems: binding?.missingMatchedItems,
      confirmed: binding ? binding.confirmed : false,
    };
    return {
      ...merged,
      mappingStatus: computeConstructMappingStatus(merged, columns, hypothesis),
    };
  });
}

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore inaccessible storage
  }
  return null;
}

export function loadWorkspaceV2(): PersistedWorkspaceV2 | null {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const rawV2 = storage.getItem(WORKSPACE_STORAGE_KEY);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as Partial<PersistedWorkspaceV2>;
      if (parsed && parsed.version === 2 && parsed.model) {
        return {
          version: 2,
          savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
          activeDatasetId: parsed.activeDatasetId ?? null,
          model: {
            constructsMeta: Array.isArray(parsed.model.constructsMeta)
              ? parsed.model.constructsMeta
              : [],
            hypothesis: parsed.model.hypothesis,
            modelSource: parsed.model.modelSource === 'user' ? 'user' : 'sample',
            revision: typeof parsed.model.revision === 'number' ? parsed.model.revision : 1,
            updatedAt: typeof parsed.model.updatedAt === 'number' ? parsed.model.updatedAt : Date.now(),
          },
          datasets: parsed.datasets ?? {},
          datasetStates: parsed.datasetStates ?? {},
        };
      }
    }

    // Migrate v1 workspace seamlessly if present
    const rawV1 = storage.getItem(LEGACY_WORKSPACE_STORAGE_KEY);
    if (rawV1) {
      const v1 = JSON.parse(rawV1) as {
        version?: number;
        savedAt?: number;
        fileName?: string;
        rows?: DataRow[];
        columns?: string[];
        parseWarnings?: string[];
        constructs?: ConstructMapping[];
        hypothesis?: HypothesisConfig;
        efaConfig?: EFAConfig;
        activeStep?: StepId;
        step0Tab?: Step0SubTab;
      };
      if (v1 && v1.version === 1 && Array.isArray(v1.constructs) && v1.hypothesis && v1.efaConfig) {
        const dsId = generateDatasetId('ds-migrated');
        const now = typeof v1.savedAt === 'number' ? v1.savedAt : Date.now();
        const { constructsMeta, bindings } = splitConstructsToMetaAndBindings(v1.constructs);
        const rows = Array.isArray(v1.rows) ? v1.rows : [];
        const columns = Array.isArray(v1.columns) ? v1.columns : [];
        const hasData = rows.length > 0 || columns.length > 0;
        const datasets: Record<string, DatasetRecord> = hasData
          ? {
              [dsId]: {
                datasetId: dsId,
                fileName: v1.fileName || '복원된 데이터',
                headerRowIndex: 0,
                columns,
                rows,
                parseWarnings: Array.isArray(v1.parseWarnings) ? v1.parseWarnings : [],
                preprocessing: null,
                createdAt: now,
                updatedAt: now,
              },
            }
          : {};
        const datasetStates: Record<string, DatasetScopedState> = hasData
          ? {
              [dsId]: {
                datasetId: dsId,
                bindings,
                analysisOptions: { ...DEFAULT_ANALYSIS_OPTIONS },
                efaConfig: v1.efaConfig,
                activeStep: v1.activeStep ?? 0,
                step0Tab: v1.step0Tab ?? 'overview',
                revision: 1,
                updatedAt: now,
              },
            }
          : {};

        return {
          version: 2,
          savedAt: now,
          activeDatasetId: hasData ? dsId : null,
          model: {
            constructsMeta,
            hypothesis: v1.hypothesis,
            modelSource: v1.fileName?.includes('매개효과test') ? 'sample' : 'user',
            revision: 1,
            updatedAt: now,
          },
          datasets,
          datasetStates,
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function saveWorkspaceV2(workspace: PersistedWorkspaceV2): { ok: boolean; quotaExceeded?: boolean } {
  const storage = getStorage();
  if (!storage) return { ok: false };

  // Keep at most 5 recent datasets in localStorage to minimize quota pressure while keeping active dataset rows
  const entries = Object.values(workspace.datasets).sort((a, b) => b.updatedAt - a.updatedAt);
  const keptDatasets: Record<string, DatasetRecord> = {};
  const keptStates: Record<string, DatasetScopedState> = {};
  entries.slice(0, 5).forEach((ds) => {
    keptDatasets[ds.datasetId] = ds;
    if (workspace.datasetStates[ds.datasetId]) {
      keptStates[ds.datasetId] = workspace.datasetStates[ds.datasetId];
    }
  });

  const payload: PersistedWorkspaceV2 = {
    ...workspace,
    version: 2,
    savedAt: Date.now(),
    datasets: keptDatasets,
    datasetStates: keptStates,
  };

  try {
    storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(payload));
    return { ok: true };
  } catch {
    // Strip rows from non-active datasets first, then active dataset if still too large
    try {
      const compactDatasets: Record<string, DatasetRecord> = {};
      for (const [id, ds] of Object.entries(keptDatasets)) {
        compactDatasets[id] =
          id === workspace.activeDatasetId ? ds : { ...ds, rows: [] };
      }
      storage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify({ ...payload, datasets: compactDatasets })
      );
      return { ok: true, quotaExceeded: true };
    } catch {
      try {
        const ultraCompact: Record<string, DatasetRecord> = {};
        for (const [id, ds] of Object.entries(keptDatasets)) {
          ultraCompact[id] = { ...ds, rows: [] };
        }
        storage.setItem(
          WORKSPACE_STORAGE_KEY,
          JSON.stringify({ ...payload, datasets: ultraCompact })
        );
        return { ok: true, quotaExceeded: true };
      } catch {
        return { ok: false, quotaExceeded: true };
      }
    }
  }
}

export function clearWorkspace(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(WORKSPACE_STORAGE_KEY);
    storage.removeItem(LEGACY_WORKSPACE_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ---------- Server API Persistence Client ----------

export interface ServerWorkspaceResponse {
  model: ResearchModelRecord | null;
  activeDatasetId: string | null;
  activeDataset: DatasetRecord | null;
  activeState: DatasetScopedState | null;
  datasets: DatasetSummaryItem[];
}

export async function fetchWorkspaceFromServer(): Promise<ServerWorkspaceResponse | null> {
  try {
    const res = await fetch('/api/workspace', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as ServerWorkspaceResponse;
  } catch {
    return null;
  }
}

export async function saveModelToServer(params: {
  constructsMeta: ConstructModelMeta[];
  hypothesis: HypothesisConfig;
  modelSource: 'sample' | 'user';
  expectedRevision?: number;
}): Promise<{ ok: boolean; revision?: number; updatedAt?: number; conflict?: boolean; currentRevision?: number; error?: string }> {
  try {
    const res = await fetch('/api/workspace/model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      return { ok: false, conflict: true, currentRevision: data.currentRevision, error: data.error };
    }
    if (!res.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true, revision: data.revision, updatedAt: data.updatedAt };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '네트워크 오류' };
  }
}

export async function createDatasetOnServer(params: {
  dataset: DatasetRecord;
  state: Omit<DatasetScopedState, 'revision' | 'updatedAt'>;
}): Promise<{ ok: boolean; datasetId?: string; revision?: number; updatedAt?: number; error?: string }> {
  try {
    const res = await fetch('/api/workspace/datasets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return {
      ok: true,
      datasetId: data.datasetId,
      revision: data.revision,
      updatedAt: data.updatedAt,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '네트워크 오류' };
  }
}

export async function saveDatasetStateToServer(
  datasetId: string,
  state: {
    bindings: Record<string, ConstructDatasetBinding>;
    analysisOptions: AnalysisOptions;
    efaConfig: EFAConfig;
    activeStep: StepId;
    step0Tab: Step0SubTab;
    bundle?: AnalysisBundle | null;
    thesisEdits?: Record<string, string>;
    expectedRevision?: number;
  }
): Promise<{ ok: boolean; revision?: number; updatedAt?: number; conflict?: boolean; currentRevision?: number; error?: string }> {
  try {
    const res = await fetch(`/api/workspace/datasets/${encodeURIComponent(datasetId)}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      return { ok: false, conflict: true, currentRevision: data.currentRevision, error: data.error };
    }
    if (!res.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true, revision: data.revision, updatedAt: data.updatedAt };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '네트워크 오류' };
  }
}

export async function activateDatasetOnServer(datasetId: string): Promise<{
  ok: boolean;
  dataset?: DatasetRecord;
  state?: DatasetScopedState | null;
  error?: string;
}> {
  try {
    const res = await fetch(`/api/workspace/datasets/${encodeURIComponent(datasetId)}/activate`, {
      method: 'POST',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true, dataset: data.dataset, state: data.state };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '네트워크 오류' };
  }
}

// ---------- Verification Snapshot & History Store ----------

export interface PersistedVerificationStore {
  version: 1;
  savedAt: number;
  lastSummary: VerificationReportSummary | null;
  history: VerificationHistoryEntry[];
}

export function loadVerificationStore(): {
  lastSummary: VerificationReportSummary | null;
  history: VerificationHistoryEntry[];
} {
  const storage = getStorage();
  if (!storage) return { lastSummary: null, history: [] };
  try {
    const raw = storage.getItem(VERIFICATION_STORAGE_KEY);
    if (!raw) return { lastSummary: null, history: [] };
    const parsed = JSON.parse(raw) as Partial<PersistedVerificationStore>;
    if (!parsed || parsed.version !== 1) return { lastSummary: null, history: [] };
    return {
      lastSummary: parsed.lastSummary ?? null,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return { lastSummary: null, history: [] };
  }
}

function writeVerificationStore(
  lastSummary: VerificationReportSummary | null,
  history: VerificationHistoryEntry[]
): void {
  const storage = getStorage();
  if (!storage) return;
  const payload: PersistedVerificationStore = {
    version: 1,
    savedAt: Date.now(),
    lastSummary,
    history: history.slice(0, 100),
  };
  try {
    storage.setItem(VERIFICATION_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    try {
      const compact: PersistedVerificationStore = {
        version: 1,
        savedAt: Date.now(),
        lastSummary,
        history: history.slice(0, 20),
      };
      storage.setItem(VERIFICATION_STORAGE_KEY, JSON.stringify(compact));
    } catch {
      // ignore
    }
  }
}

export function saveVerificationSnapshot(summary: VerificationReportSummary): void {
  const current = loadVerificationStore();
  writeVerificationStore(summary, current.history);
}

export function appendVerificationHistory(
  entry: VerificationHistoryEntry
): VerificationHistoryEntry[] {
  const current = loadVerificationStore();
  const nextHistory = [entry, ...current.history].slice(0, 100);
  writeVerificationStore(current.lastSummary, nextHistory);
  return nextHistory;
}

export function clearVerificationHistory(): void {
  const current = loadVerificationStore();
  writeVerificationStore(current.lastSummary, []);
}
