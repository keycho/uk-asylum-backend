// Asylum Decisions by Nationality - Quarterly ODS Parser
// Source: Asy_D02 from Immigration System Statistics
// Includes grant rates calculation

import { BaseIngestor, fetchUrl, parseODS, sheetToJson, getSheetNames } from '../lib/ingest';
import { query, formatDateISO, log, toQuarterEnd } from '../lib/db';

interface DecisionRecord {
  quarter_end: Date;
  year: number;
  quarter: number;
  nationality_name: string;
  decisions_total: number;
  granted_asylum: number;
  granted_hp: number;
  granted_dl: number;
  granted_uasc_leave: number;
  grants_total: number;
  refused: number;
  withdrawn: number;
  grant_rate_pct: number;
}

export class AsylumDecisionsIngestor extends BaseIngestor {
  constructor() {
    super('ASY_D02');
  }

  protected async fetch(): Promise<Buffer> {
    // Decisions ODS file
    const url = 'https://assets.publishing.service.gov.uk/media/67149071d23a62e5d32680c3/asylum-outcomes-datasets-sep-2024.ods';
    return fetchUrl(url);
  }

  protected async parse(buffer: Buffer): Promise<DecisionRecord[]> {
    const workbook = parseODS(buffer);
    const sheetNames = getSheetNames(workbook);
    
    log('info', 'Found sheets in asylum decisions file', { sheets: sheetNames });
    
    const decisionSheetName = sheetNames.find(s => 
      s.toLowerCase().includes('asy_d02') || 
      s.toLowerCase().includes('decision') ||
      s.toLowerCase().includes('outcome')
    );

    if (!decisionSheetName) {
      throw new Error('Could not find decisions sheet in asylum data');
    }

    return this.parseSheet(workbook, decisionSheetName);
  }

  private parseSheet(workbook: any, sheetName: string): DecisionRecord[] {
    const rows = sheetToJson<Record<string, any>>(workbook, sheetName);
    const results: DecisionRecord[] = [];
    
    log('info', `Parsing sheet ${sheetName}`, { rowCount: rows.length });

    if (rows.length === 0) return results;
    
    const sampleRow = rows[0];
    const keys = Object.keys(sampleRow);
    
    // Map columns
    const columnMap = {
      nationality: keys.find(k => 
        k.toLowerCase().includes('nationality') || 
        k.toLowerCase().includes('country')
      ),
      year: keys.find(k => k.toLowerCase() === 'year'),
      quarter: keys.find(k => 
        k.toLowerCase().includes('quarter') ||
        k.toLowerCase() === 'q'
      ),
      total_decisions: keys.find(k => 
        k.toLowerCase().includes('total') && 
        k.toLowerCase().includes('decision')
      ),
      granted_asylum: keys.find(k => 
        k.toLowerCase().includes('refugee') ||
        (k.toLowerCase().includes('grant') && k.toLowerCase().includes('asylum'))
      ),
      granted_hp: keys.find(k => 
        k.toLowerCase().includes('humanitarian') ||
        k.toLowerCase().includes('hp')
      ),
      granted_dl: keys.find(k => 
        k.toLowerCase().includes('discretionary') ||
        k.toLowerCase().includes('dl')
      ),
      granted_uasc: keys.find(k => 
        k.toLowerCase().includes('uasc')
      ),
      grants_total: keys.find(k => 
        k.toLowerCase().includes('total') && 
        k.toLowerCase().includes('grant')
      ),
      refused: keys.find(k => 
        k.toLowerCase().includes('refus')
      ),
      withdrawn: keys.find(k => 
        k.toLowerCase().includes('withdraw')
      ),
    };

    log('info', 'Column mappings for decisions', { columnMap });

    for (const row of rows) {
      if (!columnMap.nationality || !row[columnMap.nationality]) continue;
      
      const nationality = String(row[columnMap.nationality]).trim();
      
      if (
        nationality.toLowerCase().includes('total') ||
        nationality.toLowerCase() === 'nationality' ||
        nationality.length < 2
      ) continue;

      const parseNum = (key: string | undefined): number => {
        if (!key || !row[key]) return 0;
        const val = row[key];
        if (typeof val === 'number') return val;
        const parsed = parseInt(String(val).replace(/[^0-9-]/g, ''), 10);
        return isNaN(parsed) ? 0 : parsed;
      };

      const year = parseNum(columnMap.year) || new Date().getFullYear();
      const quarter = parseNum(columnMap.quarter) || 1;

      const record: DecisionRecord = {
        quarter_end: toQuarterEnd(year, quarter),
        year,
        quarter,
        nationality_name: nationality,
        decisions_total: parseNum(columnMap.total_decisions),
        granted_asylum: parseNum(columnMap.granted_asylum),
        granted_hp: parseNum(columnMap.granted_hp),
        granted_dl: parseNum(columnMap.granted_dl),
        granted_uasc_leave: parseNum(columnMap.granted_uasc),
        grants_total: parseNum(columnMap.grants_total),
        refused: parseNum(columnMap.refused),
        withdrawn: parseNum(columnMap.withdrawn),
        grant_rate_pct: 0,
      };

      // Calculate grants total if not present
      if (record.grants_total === 0) {
        record.grants_total = record.granted_asylum + record.granted_hp + 
                             record.granted_dl + record.granted_uasc_leave;
      }

      // Calculate decisions total if not present
      if (record.decisions_total === 0) {
        record.decisions_total = record.grants_total + record.refused + record.withdrawn;
      }

      // Calculate grant rate (excluding withdrawn from denominator)
      const substantiveDecisions = record.grants_total + record.refused;
      if (substantiveDecisions > 0) {
        record.grant_rate_pct = Math.round((record.grants_total / substantiveDecisions) * 1000) / 10;
      }

      if (record.decisions_total > 0) {
        results.push(record);
      }
    }

    return results;
  }

  protected async load(data: DecisionRecord[]): Promise<void> {
    for (const record of data) {
      const nationalityId = await this.getNationalityId(record.nationality_name);

      await query(
        `INSERT INTO asylum_decisions (
          quarter_end, year, quarter, nationality_id, nationality_name,
          decisions_total, granted_asylum, granted_hp, granted_dl, granted_uasc_leave,
          grants_total, refused, withdrawn, grant_rate_pct, ingest_run_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT DO NOTHING`,
        [
          formatDateISO(record.quarter_end),
          record.year,
          record.quarter,
          nationalityId,
          record.nationality_name,
          record.decisions_total,
          record.granted_asylum,
          record.granted_hp,
          record.granted_dl,
          record.granted_uasc_leave,
          record.grants_total,
          record.refused,
          record.withdrawn,
          record.grant_rate_pct,
          this.runId,
        ]
      );
      this.recordsInserted++;
    }

    // Log top grant rates for verification
    const topRates = data
      .filter(d => d.decisions_total >= 100)
      .sort((a, b) => b.grant_rate_pct - a.grant_rate_pct)
      .slice(0, 10);
    
    log('info', 'Top grant rates (min 100 decisions)', {
      rates: topRates.map(r => ({ nationality: r.nationality_name, rate: r.grant_rate_pct }))
    });
  }
}
