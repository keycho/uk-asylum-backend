// Core ingestion framework
import { query, getOne, hashContent, log, withTransaction } from './db';
import { DataSource, IngestRun, IngestStatus } from '../types';
import { PoolClient } from 'pg';

// =============================================================================
// INGESTION BASE CLASS
// =============================================================================

export abstract class BaseIngestor {
  protected sourceCode: string;
  protected source: DataSource | null = null;
  protected runId: string | null = null;
  protected recordsProcessed = 0;
  protected recordsInserted = 0;
  protected recordsUpdated = 0;

  constructor(sourceCode: string) {
    this.sourceCode = sourceCode;
  }

  /**
   * Main entry point - handles the full ingestion lifecycle
   */
  async run(): Promise<IngestRun> {
    // Get source configuration
    this.source = await this.getSource();
    if (!this.source) {
      throw new Error(`Data source not found: ${this.sourceCode}`);
    }

    // Create ingest run record
    this.runId = await this.createRun();
    
    try {
      // Mark as running
      await this.updateRunStatus('running');
      
      // Fetch data
      log('info', `Fetching data for ${this.sourceCode}`, { runId: this.runId });
      const rawData = await this.fetch();
      
      // Check if content has changed
      const contentHash = hashContent(typeof rawData === 'string' ? rawData : JSON.stringify(rawData));
      if (this.source.content_hash === contentHash) {
        log('info', `No changes detected for ${this.sourceCode}`, { runId: this.runId });
        await this.updateRunStatus('completed', { contentHash, noChanges: true });
        return this.getRun();
      }
      
      // Parse data
      log('info', `Parsing data for ${this.sourceCode}`, { runId: this.runId });
      const parsedData = await this.parse(rawData);
      this.recordsProcessed = Array.isArray(parsedData) ? parsedData.length : 1;
      
      // Transform and validate
      log('info', `Transforming data for ${this.sourceCode}`, { runId: this.runId, records: this.recordsProcessed });
      const transformedData = await this.transform(parsedData);
      
      // Load to database
      log('info', `Loading data for ${this.sourceCode}`, { runId: this.runId });
      await this.load(transformedData);
      
      // Update source last_updated and content_hash
      await query(
        `UPDATE data_sources SET last_updated = NOW(), last_checked = NOW(), content_hash = $1 WHERE code = $2`,
        [contentHash, this.sourceCode]
      );
      
      // Mark as completed
      await this.updateRunStatus('completed', { contentHash });
      
      log('info', `Ingestion completed for ${this.sourceCode}`, {
        runId: this.runId,
        processed: this.recordsProcessed,
        inserted: this.recordsInserted,
        updated: this.recordsUpdated,
      });
      
      return this.getRun();
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log('error', `Ingestion failed for ${this.sourceCode}`, { runId: this.runId, error: errorMessage });
      await this.updateRunStatus('failed', { error: errorMessage });
      throw error;
    }
  }

  /**
   * Fetch raw data from source - must be implemented by subclass
   */
  protected abstract fetch(): Promise<any>;

  /**
   * Parse raw data into structured format - must be implemented by subclass
   */
  protected abstract parse(rawData: any): Promise<any>;

  /**
   * Transform parsed data for loading - can be overridden
   */
  protected async transform(parsedData: any): Promise<any> {
    return parsedData;
  }

  /**
   * Load transformed data to database - must be implemented by subclass
   */
  protected abstract load(data: any): Promise<void>;

  // =============================================================================
  // HELPER METHODS
  // =============================================================================

  protected async getSource(): Promise<DataSource | null> {
    return getOne<DataSource>(
      'SELECT * FROM data_sources WHERE code = $1',
      [this.sourceCode]
    );
  }

  protected async createRun(): Promise<string> {
    const result = await query(
      `INSERT INTO ingest_runs (source_id, status) VALUES ($1, 'pending') RETURNING id`,
      [this.source!.id]
    );
    return result.rows[0].id;
  }

  protected async updateRunStatus(
    status: IngestStatus,
    extra?: { contentHash?: string; error?: string; noChanges?: boolean }
  ): Promise<void> {
    const updates: string[] = [`status = $1`];
    const values: any[] = [status];
    let paramIndex = 2;

    if (status === 'completed' || status === 'failed') {
      updates.push(`completed_at = NOW()`);
    }

    if (extra?.contentHash) {
      updates.push(`content_hash = $${paramIndex++}`);
      values.push(extra.contentHash);
    }

    if (extra?.error) {
      updates.push(`error_message = $${paramIndex++}`);
      values.push(extra.error);
    }

    updates.push(`records_processed = $${paramIndex++}`);
    values.push(this.recordsProcessed);

    updates.push(`records_inserted = $${paramIndex++}`);
    values.push(this.recordsInserted);

    updates.push(`records_updated = $${paramIndex++}`);
    values.push(this.recordsUpdated);

    updates.push(`metadata = $${paramIndex++}`);
    values.push(JSON.stringify({ noChanges: extra?.noChanges || false }));

    values.push(this.runId);

    await query(
      `UPDATE ingest_runs SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
  }

  protected async getRun(): Promise<IngestRun> {
    return getOne<IngestRun>('SELECT * FROM ingest_runs WHERE id = $1', [this.runId])!;
  }

  /**
   * Helper to get or create nationality ID
   */
  protected async getNationalityId(name: string): Promise<number | null> {
    if (!name || name === '' || name === 'Unknown' || name === 'Other') {
      return null;
    }

    // Try exact match first
    let result = await getOne<{ id: number }>(
      'SELECT id FROM nationalities WHERE name = $1 OR name_normalized = $2',
      [name, name.toLowerCase().trim()]
    );

    if (result) return result.id;

    // Create new nationality
    const insertResult = await query(
      `INSERT INTO nationalities (name, name_normalized) VALUES ($1, $2) 
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name, name.toLowerCase().trim()]
    );

    return insertResult.rows[0]?.id || null;
  }

  /**
   * Helper to get or create LA ID
   */
  protected async getLAId(name: string): Promise<number | null> {
    if (!name || name === '' || name === 'Unknown') {
      return null;
    }

    const normalized = name.toLowerCase().trim();

    // Try exact match first
    let result = await getOne<{ id: number }>(
      'SELECT id FROM local_authorities WHERE name = $1 OR name_normalized = $2',
      [name, normalized]
    );

    if (result) return result.id;

    // Try fuzzy match
    result = await getOne<{ id: number }>(
      `SELECT id FROM local_authorities 
       WHERE name_normalized % $1 
       ORDER BY similarity(name_normalized, $1) DESC 
       LIMIT 1`,
      [normalized]
    );

    return result?.id || null;
  }
}

// =============================================================================
// ODS FILE PARSER
// =============================================================================

import * as xlsx from 'xlsx';
import * as https from 'https';
import * as http from 'http';

export async function fetchUrl(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(url, { 
      headers: { 
        'User-Agent': 'UK-Asylum-Dashboard/1.0 (Research)',
        'Accept': '*/*'
      }
    }, (res) => {
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (res.headers.location) {
          fetchUrl(res.headers.location).then(resolve).catch(reject);
          return;
        }
      }
      
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        return;
      }
      
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

export function parseODS(buffer: Buffer): xlsx.WorkBook {
  return xlsx.read(buffer, { type: 'buffer' });
}

export function sheetToJson<T = any>(
  workbook: xlsx.WorkBook,
  sheetName: string,
  options?: { header?: number; range?: string }
): T[] {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Sheet not found: ${sheetName}`);
  }
  
  return xlsx.utils.sheet_to_json<T>(sheet, {
    header: options?.header,
    range: options?.range,
    defval: null,
  });
}

export function getSheetNames(workbook: xlsx.WorkBook): string[] {
  return workbook.SheetNames;
}

// =============================================================================
// HTML SCRAPER
// =============================================================================

import * as cheerio from 'cheerio';

export async function fetchHtml(url: string): Promise<string> {
  const buffer = await fetchUrl(url);
  return buffer.toString('utf-8');
}

export function parseHtml(html: string): cheerio.CheerioAPI {
  return cheerio.load(html);
}

// =============================================================================
// SCHEDULING
// =============================================================================

export interface ScheduleConfig {
  sourceCode: string;
  cron: string;
  enabled: boolean;
}

export const INGESTION_SCHEDULE: ScheduleConfig[] = [
  // Tier A: Daily/Weekly
  { sourceCode: 'SBA_DAILY', cron: '0 7,10,13,16,19,22 * * *', enabled: true }, // Every 3 hours 7am-10pm
  { sourceCode: 'SBA_WEEKLY', cron: '0 12 * * 5', enabled: true }, // Fridays at noon
  { sourceCode: 'FRENCH_PREV', cron: '0 12 * * 5', enabled: true }, // Fridays at noon
  { sourceCode: 'UKRAINE', cron: '0 10 * * 1', enabled: true }, // Mondays at 10am
  
  // Tier B: Quarterly (check daily, actual updates quarterly)
  { sourceCode: 'ASY_D01', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'ASY_D02', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'ASY_D03', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'ASY_D06', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'ASY_D07', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'ASY_D09', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'ASY_D11', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'HMCTS_FIA', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'DET_D01', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'DET_D02', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'DET_D03', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'DET_D04', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'RET_D01', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'RET_D02', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'IRR_D02', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'NRM_STATS', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'RES_D01', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'RES_D02', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'FAM_D01', cron: '0 9 * * *', enabled: true },
  { sourceCode: 'MOJ_FNP', cron: '0 9 * * *', enabled: true },
  
  // Tier C: Annual (check weekly)
  { sourceCode: 'ONS_POP', cron: '0 9 * * 1', enabled: true },
];

// =============================================================================
// RUN ALL INGESTORS
// =============================================================================

import { SmallBoatDailyIngestor } from '../ingestion/small-boats-daily';
import { SmallBoatWeeklyIngestor } from '../ingestion/small-boats-weekly';
import { AsylumSupportLAIngestor } from '../ingestion/asylum-support-la';
import { AsylumClaimsIngestor } from '../ingestion/asylum-claims';
import { AsylumDecisionsIngestor } from '../ingestion/asylum-decisions';
import { AsylumBacklogIngestor } from '../ingestion/asylum-backlog';

const INGESTORS: Record<string, new () => BaseIngestor> = {
  'SBA_DAILY': SmallBoatDailyIngestor,
  'SBA_WEEKLY': SmallBoatWeeklyIngestor,
  'ASY_D11': AsylumSupportLAIngestor,
  'ASY_D01': AsylumClaimsIngestor,
  'ASY_D02': AsylumDecisionsIngestor,
  'ASY_D03': AsylumBacklogIngestor,
  // Add more as implemented
};

export async function runIngestor(sourceCode: string): Promise<IngestRun> {
  const IngestorClass = INGESTORS[sourceCode];
  if (!IngestorClass) {
    throw new Error(`No ingestor implemented for: ${sourceCode}`);
  }
  
  const ingestor = new IngestorClass();
  return ingestor.run();
}

export async function runAllIngestors(tier?: 'A' | 'B' | 'C'): Promise<IngestRun[]> {
  const sources = await query<DataSource>(
    tier 
      ? 'SELECT * FROM data_sources WHERE tier = $1 AND status = $2'
      : 'SELECT * FROM data_sources WHERE status = $1',
    tier ? [tier, 'active'] : ['active']
  );
  
  const results: IngestRun[] = [];
  
  for (const source of sources.rows) {
    if (INGESTORS[source.code]) {
      try {
        const run = await runIngestor(source.code);
        results.push(run);
      } catch (error) {
        log('error', `Failed to run ingestor: ${source.code}`, { 
          error: error instanceof Error ? error.message : String(error) 
        });
      }
    }
  }
  
  return results;
}
