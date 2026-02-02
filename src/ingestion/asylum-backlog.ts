// Asylum Backlog - Quarterly ODS Parser
// Source: Asy_D03 from Immigration System Statistics
// Tracks people awaiting initial decision

import { BaseIngestor, fetchUrl, parseODS, sheetToJson, getSheetNames } from '../lib/ingest';
import { query, formatDateISO, log } from '../lib/db';

interface BacklogRecord {
  snapshot_date: Date;
  total_awaiting: number;
  awaiting_initial: number;
  awaiting_further_review: number;
  awaiting_less_6_months: number;
  awaiting_6_12_months: number;
  awaiting_1_3_years: number;
  awaiting_3_plus_years: number;
  legacy_cases: number;
}

export class AsylumBacklogIngestor extends BaseIngestor {
  constructor() {
    super('ASY_D03');
  }

  protected async fetch(): Promise<Buffer> {
    const url = 'https://assets.publishing.service.gov.uk/media/6714906d30536cb9274830b3/asylum-applications-datasets-sep-2024.ods';
    return fetchUrl(url);
  }

  protected async parse(buffer: Buffer): Promise<BacklogRecord[]> {
    const workbook = parseODS(buffer);
    const sheetNames = getSheetNames(workbook);
    
    log('info', 'Found sheets in asylum backlog file', { sheets: sheetNames });
    
    const backlogSheetName = sheetNames.find(s => 
      s.toLowerCase().includes('asy_d03') || 
      s.toLowerCase().includes('backlog') ||
      s.toLowerCase().includes('awaiting') ||
      s.toLowerCase().includes('work_in_progress') ||
      s.toLowerCase().includes('wip')
    );

    if (!backlogSheetName) {
      throw new Error('Could not find backlog sheet in asylum data');
    }

    return this.parseSheet(workbook, backlogSheetName);
  }

  private parseSheet(workbook: any, sheetName: string): BacklogRecord[] {
    const rows = sheetToJson<Record<string, any>>(workbook, sheetName);
    const results: BacklogRecord[] = [];
    
    log('info', `Parsing sheet ${sheetName}`, { rowCount: rows.length });

    if (rows.length === 0) return results;
    
    const sampleRow = rows[0];
    const keys = Object.keys(sampleRow);
    
    const columnMap = {
      date: keys.find(k => 
        k.toLowerCase().includes('date') || 
        k.toLowerCase().includes('quarter') ||
        k.toLowerCase().includes('period') ||
        k.toLowerCase().includes('as_at')
      ),
      total: keys.find(k => 
        k.toLowerCase().includes('total') && 
        !k.toLowerCase().includes('sub')
      ),
      initial: keys.find(k => 
        k.toLowerCase().includes('initial')
      ),
      further_review: keys.find(k => 
        k.toLowerCase().includes('further') ||
        k.toLowerCase().includes('review')
      ),
      less_6_months: keys.find(k => 
        k.toLowerCase().includes('6') && 
        (k.toLowerCase().includes('less') || k.toLowerCase().includes('under'))
      ),
      six_12_months: keys.find(k => 
        k.toLowerCase().includes('6') && 
        k.toLowerCase().includes('12')
      ),
      one_3_years: keys.find(k => 
        (k.toLowerCase().includes('1') || k.toLowerCase().includes('one')) &&
        k.toLowerCase().includes('3')
      ),
      three_plus: keys.find(k => 
        k.toLowerCase().includes('3') && 
        (k.toLowerCase().includes('plus') || k.toLowerCase().includes('more') || k.toLowerCase().includes('+'))
      ),
      legacy: keys.find(k => 
        k.toLowerCase().includes('legacy') ||
        k.toLowerCase().includes('pre')
      ),
    };

    log('info', 'Column mappings for backlog', { columnMap });

    for (const row of rows) {
      // Try to get a date
      let snapshotDate: Date | null = null;
      
      if (columnMap.date && row[columnMap.date]) {
        const dateVal = row[columnMap.date];
        if (typeof dateVal === 'number') {
          snapshotDate = new Date((dateVal - 25569) * 86400 * 1000);
        } else if (typeof dateVal === 'string') {
          const parsed = new Date(dateVal);
          if (!isNaN(parsed.getTime())) {
            snapshotDate = parsed;
          }
        }
      }

      if (!snapshotDate) continue;

      const parseNum = (key: string | undefined): number => {
        if (!key || !row[key]) return 0;
        const val = row[key];
        if (typeof val === 'number') return val;
        const parsed = parseInt(String(val).replace(/[^0-9-]/g, ''), 10);
        return isNaN(parsed) ? 0 : parsed;
      };

      const record: BacklogRecord = {
        snapshot_date: snapshotDate,
        total_awaiting: parseNum(columnMap.total),
        awaiting_initial: parseNum(columnMap.initial),
        awaiting_further_review: parseNum(columnMap.further_review),
        awaiting_less_6_months: parseNum(columnMap.less_6_months),
        awaiting_6_12_months: parseNum(columnMap.six_12_months),
        awaiting_1_3_years: parseNum(columnMap.one_3_years),
        awaiting_3_plus_years: parseNum(columnMap.three_plus),
        legacy_cases: parseNum(columnMap.legacy),
      };

      // Calculate total if not present
      if (record.total_awaiting === 0) {
        record.total_awaiting = record.awaiting_initial + record.awaiting_further_review;
      }

      if (record.total_awaiting > 0) {
        results.push(record);
      }
    }

    // Sort by date descending
    results.sort((a, b) => b.snapshot_date.getTime() - a.snapshot_date.getTime());

    return results;
  }

  protected async load(data: BacklogRecord[]): Promise<void> {
    for (const record of data) {
      await query(
        `INSERT INTO asylum_backlog (
          snapshot_date, total_awaiting, awaiting_initial, awaiting_further_review,
          awaiting_less_6_months, awaiting_6_12_months, awaiting_1_3_years, awaiting_3_plus_years,
          legacy_cases, ingest_run_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (snapshot_date) DO UPDATE SET
          total_awaiting = EXCLUDED.total_awaiting,
          awaiting_initial = EXCLUDED.awaiting_initial,
          awaiting_further_review = EXCLUDED.awaiting_further_review,
          awaiting_less_6_months = EXCLUDED.awaiting_less_6_months,
          awaiting_6_12_months = EXCLUDED.awaiting_6_12_months,
          awaiting_1_3_years = EXCLUDED.awaiting_1_3_years,
          awaiting_3_plus_years = EXCLUDED.awaiting_3_plus_years,
          legacy_cases = EXCLUDED.legacy_cases`,
        [
          formatDateISO(record.snapshot_date),
          record.total_awaiting,
          record.awaiting_initial,
          record.awaiting_further_review,
          record.awaiting_less_6_months,
          record.awaiting_6_12_months,
          record.awaiting_1_3_years,
          record.awaiting_3_plus_years,
          record.legacy_cases,
          this.runId,
        ]
      );
      this.recordsInserted++;
    }

    // Log latest backlog for verification
    if (data.length > 0) {
      const latest = data[0];
      log('info', 'Latest backlog snapshot', {
        date: formatDateISO(latest.snapshot_date),
        total: latest.total_awaiting,
        breakdown: {
          less_6m: latest.awaiting_less_6_months,
          '6-12m': latest.awaiting_6_12_months,
          '1-3y': latest.awaiting_1_3_years,
          '3y+': latest.awaiting_3_plus_years,
        }
      });
    }
  }
}
