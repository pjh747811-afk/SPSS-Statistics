import express from 'express';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { createServer as createViteServer } from 'vite';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'statflow.db');

export interface ServerStorage {
  db: DatabaseSync;
  close: () => void;
}

export function initDatabase(dbPath: string = DB_PATH): DatabaseSync {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS research_models (
      id TEXT PRIMARY KEY,
      model_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'sample',
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS datasets (
      dataset_id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      sheet_name TEXT,
      header_row_index INTEGER NOT NULL DEFAULT 0,
      columns_json TEXT NOT NULL,
      rows_json TEXT NOT NULL,
      parse_warnings_json TEXT NOT NULL,
      preprocessing_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dataset_states (
      dataset_id TEXT PRIMARY KEY,
      bindings_json TEXT NOT NULL,
      analysis_options_json TEXT NOT NULL,
      efa_config_json TEXT NOT NULL,
      active_step INTEGER NOT NULL DEFAULT 0,
      step0_tab TEXT NOT NULL DEFAULT 'overview',
      bundle_json TEXT,
      thesis_edits_json TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (dataset_id) REFERENCES datasets(dataset_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_meta (
      id TEXT PRIMARY KEY,
      active_dataset_id TEXT,
      updated_at INTEGER NOT NULL
    );
  `);

  return db;
}

function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function createApp(db: DatabaseSync): express.Express {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, db: 'sqlite', timestamp: Date.now() });
  });

  app.get('/api/workspace', (_req, res) => {
    try {
      const modelRow = db
        .prepare('SELECT id, model_json, source, revision, updated_at FROM research_models WHERE id = ?')
        .get('default') as
        | { id: string; model_json: string; source: string; revision: number; updated_at: number }
        | undefined;

      const metaRow = db
        .prepare('SELECT active_dataset_id, updated_at FROM workspace_meta WHERE id = ?')
        .get('default') as { active_dataset_id: string | null; updated_at: number } | undefined;

      const datasetList = db
        .prepare(
          'SELECT dataset_id, file_name, sheet_name, header_row_index, preprocessing_json, created_at, updated_at FROM datasets ORDER BY updated_at DESC LIMIT 20'
        )
        .all() as {
        dataset_id: string;
        file_name: string;
        sheet_name: string | null;
        header_row_index: number;
        preprocessing_json: string;
        created_at: number;
        updated_at: number;
      }[];

      const activeId = metaRow?.active_dataset_id ?? datasetList[0]?.dataset_id ?? null;

      let activeDataset: Record<string, unknown> | null = null;
      let activeState: Record<string, unknown> | null = null;

      if (activeId) {
        const dsRow = db
          .prepare('SELECT * FROM datasets WHERE dataset_id = ?')
          .get(activeId) as
          | {
              dataset_id: string;
              file_name: string;
              sheet_name: string | null;
              header_row_index: number;
              columns_json: string;
              rows_json: string;
              parse_warnings_json: string;
              preprocessing_json: string;
              created_at: number;
              updated_at: number;
            }
          | undefined;

        const stRow = db
          .prepare('SELECT * FROM dataset_states WHERE dataset_id = ?')
          .get(activeId) as
          | {
              dataset_id: string;
              bindings_json: string;
              analysis_options_json: string;
              efa_config_json: string;
              active_step: number;
              step0_tab: string;
              bundle_json: string | null;
              thesis_edits_json: string | null;
              revision: number;
              updated_at: number;
            }
          | undefined;

        if (dsRow) {
          activeDataset = {
            datasetId: dsRow.dataset_id,
            fileName: dsRow.file_name,
            sheetName: dsRow.sheet_name ?? undefined,
            headerRowIndex: dsRow.header_row_index,
            columns: safeJsonParse(dsRow.columns_json, []),
            rows: safeJsonParse(dsRow.rows_json, []),
            parseWarnings: safeJsonParse(dsRow.parse_warnings_json, []),
            preprocessing: safeJsonParse(dsRow.preprocessing_json, null),
            createdAt: dsRow.created_at,
            updatedAt: dsRow.updated_at,
          };
        }

        if (stRow) {
          activeState = {
            datasetId: stRow.dataset_id,
            bindings: safeJsonParse(stRow.bindings_json, {}),
            analysisOptions: safeJsonParse(stRow.analysis_options_json, null),
            efaConfig: safeJsonParse(stRow.efa_config_json, null),
            activeStep: stRow.active_step,
            step0Tab: stRow.step0_tab,
            bundle: safeJsonParse(stRow.bundle_json, null),
            thesisEdits: safeJsonParse(stRow.thesis_edits_json, {}),
            revision: stRow.revision,
            updatedAt: stRow.updated_at,
          };
        }
      }

      res.json({
        model: modelRow
          ? {
              ...safeJsonParse(modelRow.model_json, {}),
              modelSource: modelRow.source,
              revision: modelRow.revision,
              updatedAt: modelRow.updated_at,
            }
          : null,
        activeDatasetId: activeId,
        activeDataset,
        activeState,
        datasets: datasetList.map((d) => {
          const prep = safeJsonParse<{ rowCount?: number; colCount?: number }>(d.preprocessing_json, {});
          return {
            datasetId: d.dataset_id,
            fileName: d.file_name,
            sheetName: d.sheet_name ?? undefined,
            headerRowIndex: d.header_row_index,
            rowCount: prep.rowCount ?? 0,
            colCount: prep.colCount ?? 0,
            createdAt: d.created_at,
            updatedAt: d.updated_at,
          };
        }),
      });
    } catch (err) {
      console.error('[DB] GET /api/workspace error:', err);
      res.status(500).json({ error: '작업공간 데이터를 불러오는 중 데이터베이스 오류가 발생했습니다.' });
    }
  });

  app.put('/api/workspace/model', (req, res) => {
    try {
      const { constructsMeta, hypothesis, modelSource = 'user', expectedRevision } = req.body ?? {};
      if (!Array.isArray(constructsMeta) || !hypothesis) {
        res.status(400).json({ error: '유효하지 않은 연구모형 요청입니다.' });
        return;
      }
      const now = Date.now();
      const existing = db
        .prepare('SELECT revision FROM research_models WHERE id = ?')
        .get('default') as { revision: number } | undefined;

      if (
        existing &&
        typeof expectedRevision === 'number' &&
        expectedRevision > 0 &&
        existing.revision !== expectedRevision
      ) {
        res.status(409).json({
          error: '연구모형 저장 충돌이 감지되었습니다.',
          currentRevision: existing.revision,
        });
        return;
      }

      const nextRev = existing ? existing.revision + 1 : 1;
      const modelJson = JSON.stringify({ constructsMeta, hypothesis });

      db.prepare(
        `INSERT INTO research_models (id, model_json, source, revision, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           model_json = excluded.model_json,
           source = excluded.source,
           revision = excluded.revision,
           updated_at = excluded.updated_at`
      ).run('default', modelJson, String(modelSource), nextRev, now);

      res.json({ ok: true, revision: nextRev, updatedAt: now });
    } catch (err) {
      console.error('[DB] PUT /api/workspace/model error:', err);
      res.status(500).json({ error: '연구모형 저장 중 오류가 발생했습니다.' });
    }
  });

  app.post('/api/workspace/datasets', (req, res) => {
    try {
      const { dataset, state } = req.body ?? {};
      if (!dataset || typeof dataset.datasetId !== 'string' || !Array.isArray(dataset.columns) || !Array.isArray(dataset.rows)) {
        res.status(400).json({ error: '유효하지 않은 데이터셋 payload입니다.' });
        return;
      }
      const now = Date.now();
      const datasetId = dataset.datasetId;

      db.exec('BEGIN');
      try {
        db.prepare(
          `INSERT INTO datasets (
             dataset_id, file_name, sheet_name, header_row_index,
             columns_json, rows_json, parse_warnings_json, preprocessing_json,
             created_at, updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(dataset_id) DO UPDATE SET
             file_name = excluded.file_name,
             sheet_name = excluded.sheet_name,
             header_row_index = excluded.header_row_index,
             columns_json = excluded.columns_json,
             rows_json = excluded.rows_json,
             parse_warnings_json = excluded.parse_warnings_json,
             preprocessing_json = excluded.preprocessing_json,
             updated_at = excluded.updated_at`
        ).run(
          datasetId,
          String(dataset.fileName || '업로드 데이터'),
          dataset.sheetName ? String(dataset.sheetName) : null,
          Number.isFinite(dataset.headerRowIndex) ? Number(dataset.headerRowIndex) : 0,
          JSON.stringify(dataset.columns),
          JSON.stringify(dataset.rows),
          JSON.stringify(dataset.parseWarnings ?? []),
          JSON.stringify(dataset.preprocessing ?? {}),
          typeof dataset.createdAt === 'number' ? dataset.createdAt : now,
          now
        );

        const existingState = db
          .prepare('SELECT revision FROM dataset_states WHERE dataset_id = ?')
          .get(datasetId) as { revision: number } | undefined;
        const nextRev = existingState ? existingState.revision + 1 : 1;

        db.prepare(
          `INSERT INTO dataset_states (
             dataset_id, bindings_json, analysis_options_json, efa_config_json,
             active_step, step0_tab, bundle_json, thesis_edits_json, revision, updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(dataset_id) DO UPDATE SET
             bindings_json = excluded.bindings_json,
             analysis_options_json = excluded.analysis_options_json,
             efa_config_json = excluded.efa_config_json,
             active_step = excluded.active_step,
             step0_tab = excluded.step0_tab,
             bundle_json = excluded.bundle_json,
             thesis_edits_json = excluded.thesis_edits_json,
             revision = excluded.revision,
             updated_at = excluded.updated_at`
        ).run(
          datasetId,
          JSON.stringify(state?.bindings ?? {}),
          JSON.stringify(state?.analysisOptions ?? {}),
          JSON.stringify(state?.efaConfig ?? {}),
          Number.isFinite(state?.activeStep) ? Number(state.activeStep) : 0,
          String(state?.step0Tab ?? 'overview'),
          state?.bundle ? JSON.stringify(state.bundle) : null,
          JSON.stringify(state?.thesisEdits ?? {}),
          nextRev,
          now
        );

        db.prepare(
          `INSERT INTO workspace_meta (id, active_dataset_id, updated_at)
           VALUES ('default', ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             active_dataset_id = excluded.active_dataset_id,
             updated_at = excluded.updated_at`
        ).run(datasetId, now);

        db.exec('COMMIT');
        res.json({ ok: true, datasetId, revision: nextRev, updatedAt: now });
      } catch (innerErr) {
        db.exec('ROLLBACK');
        throw innerErr;
      }
    } catch (err) {
      console.error('[DB] POST /api/workspace/datasets error:', err);
      res.status(500).json({ error: '데이터셋 저장 중 오류가 발생했습니다.' });
    }
  });

  app.put('/api/workspace/datasets/:datasetId/state', (req, res) => {
    try {
      const { datasetId } = req.params;
      const {
        bindings,
        analysisOptions,
        efaConfig,
        activeStep = 0,
        step0Tab = 'overview',
        bundle = null,
        thesisEdits = {},
        expectedRevision,
      } = req.body ?? {};

      const dsExists = db
        .prepare('SELECT dataset_id FROM datasets WHERE dataset_id = ?')
        .get(datasetId) as { dataset_id: string } | undefined;
      if (!dsExists) {
        res.status(404).json({ error: '대상 데이터셋을 찾을 수 없습니다.' });
        return;
      }

      const existing = db
        .prepare('SELECT revision FROM dataset_states WHERE dataset_id = ?')
        .get(datasetId) as { revision: number } | undefined;

      if (
        existing &&
        typeof expectedRevision === 'number' &&
        expectedRevision > 0 &&
        existing.revision !== expectedRevision
      ) {
        res.status(409).json({
          error: '데이터셋 상태 저장 충돌이 감지되었습니다.',
          currentRevision: existing.revision,
        });
        return;
      }

      const now = Date.now();
      const nextRev = existing ? existing.revision + 1 : 1;

      db.prepare(
        `INSERT INTO dataset_states (
           dataset_id, bindings_json, analysis_options_json, efa_config_json,
           active_step, step0_tab, bundle_json, thesis_edits_json, revision, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dataset_id) DO UPDATE SET
           bindings_json = excluded.bindings_json,
           analysis_options_json = excluded.analysis_options_json,
           efa_config_json = excluded.efa_config_json,
           active_step = excluded.active_step,
           step0_tab = excluded.step0_tab,
           bundle_json = excluded.bundle_json,
           thesis_edits_json = excluded.thesis_edits_json,
           revision = excluded.revision,
           updated_at = excluded.updated_at`
      ).run(
        datasetId,
        JSON.stringify(bindings ?? {}),
        JSON.stringify(analysisOptions ?? {}),
        JSON.stringify(efaConfig ?? {}),
        Number(activeStep) || 0,
        String(step0Tab || 'overview'),
        bundle ? JSON.stringify(bundle) : null,
        JSON.stringify(thesisEdits ?? {}),
        nextRev,
        now
      );

      db.prepare(
        `INSERT INTO workspace_meta (id, active_dataset_id, updated_at)
         VALUES ('default', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           active_dataset_id = excluded.active_dataset_id,
           updated_at = excluded.updated_at`
      ).run(datasetId, now);

      res.json({ ok: true, datasetId, revision: nextRev, updatedAt: now });
    } catch (err) {
      console.error('[DB] PUT /api/workspace/datasets/:id/state error:', err);
      res.status(500).json({ error: '데이터셋 상태 저장 중 오류가 발생했습니다.' });
    }
  });

  app.post('/api/workspace/datasets/:datasetId/activate', (req, res) => {
    try {
      const { datasetId } = req.params;
      const dsRow = db
        .prepare('SELECT * FROM datasets WHERE dataset_id = ?')
        .get(datasetId) as
        | {
            dataset_id: string;
            file_name: string;
            sheet_name: string | null;
            header_row_index: number;
            columns_json: string;
            rows_json: string;
            parse_warnings_json: string;
            preprocessing_json: string;
            created_at: number;
            updated_at: number;
          }
        | undefined;
      if (!dsRow) {
        res.status(404).json({ error: '데이터셋을 찾을 수 없습니다.' });
        return;
      }

      const stRow = db
        .prepare('SELECT * FROM dataset_states WHERE dataset_id = ?')
        .get(datasetId) as
        | {
            dataset_id: string;
            bindings_json: string;
            analysis_options_json: string;
            efa_config_json: string;
            active_step: number;
            step0_tab: string;
            bundle_json: string | null;
            thesis_edits_json: string | null;
            revision: number;
            updated_at: number;
          }
        | undefined;

      const now = Date.now();
      db.prepare(
        `INSERT INTO workspace_meta (id, active_dataset_id, updated_at)
         VALUES ('default', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           active_dataset_id = excluded.active_dataset_id,
           updated_at = excluded.updated_at`
      ).run(datasetId, now);

      res.json({
        ok: true,
        dataset: {
          datasetId: dsRow.dataset_id,
          fileName: dsRow.file_name,
          sheetName: dsRow.sheet_name ?? undefined,
          headerRowIndex: dsRow.header_row_index,
          columns: safeJsonParse(dsRow.columns_json, []),
          rows: safeJsonParse(dsRow.rows_json, []),
          parseWarnings: safeJsonParse(dsRow.parse_warnings_json, []),
          preprocessing: safeJsonParse(dsRow.preprocessing_json, null),
          createdAt: dsRow.created_at,
          updatedAt: dsRow.updated_at,
        },
        state: stRow
          ? {
              datasetId: stRow.dataset_id,
              bindings: safeJsonParse(stRow.bindings_json, {}),
              analysisOptions: safeJsonParse(stRow.analysis_options_json, null),
              efaConfig: safeJsonParse(stRow.efa_config_json, null),
              activeStep: stRow.active_step,
              step0Tab: stRow.step0_tab,
              bundle: safeJsonParse(stRow.bundle_json, null),
              thesisEdits: safeJsonParse(stRow.thesis_edits_json, {}),
              revision: stRow.revision,
              updatedAt: stRow.updated_at,
            }
          : null,
      });
    } catch (err) {
      console.error('[DB] POST /api/workspace/datasets/:id/activate error:', err);
      res.status(500).json({ error: '데이터셋 전환 중 오류가 발생했습니다.' });
    }
  });

  app.delete('/api/workspace/datasets/:datasetId', (req, res) => {
    try {
      const { datasetId } = req.params;
      db.prepare('DELETE FROM datasets WHERE dataset_id = ?').run(datasetId);
      const meta = db
        .prepare('SELECT active_dataset_id FROM workspace_meta WHERE id = ?')
        .get('default') as { active_dataset_id: string | null } | undefined;
      if (meta?.active_dataset_id === datasetId) {
        const nextRow = db
          .prepare('SELECT dataset_id FROM datasets ORDER BY updated_at DESC LIMIT 1')
          .get() as { dataset_id: string } | undefined;
        db.prepare('UPDATE workspace_meta SET active_dataset_id = ?, updated_at = ? WHERE id = ?').run(
          nextRow?.dataset_id ?? null,
          Date.now(),
          'default'
        );
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[DB] DELETE /api/workspace/datasets/:id error:', err);
      res.status(500).json({ error: '데이터셋 삭제 중 오류가 발생했습니다.' });
    }
  });

  return app;
}

async function startServer() {
  const db = initDatabase();
  const app = createApp(db);

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, HOST, () => {
    console.log(`[SPSS 연구통계] Server listening on http://${HOST}:${PORT}`);
  });
}

// Start HTTP server only when invoked directly as entrypoint
const isEntry =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  path.resolve(process.argv[1]).endsWith('server.ts');

if (isEntry) {
  startServer().catch((err) => {
    console.error('[SPSS 연구통계] Failed to start server:', err);
    process.exit(1);
  });
}
