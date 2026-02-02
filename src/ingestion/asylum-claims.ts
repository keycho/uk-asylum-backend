// Asylum Claims by Nationality - Quarterly ODS Parser
// Source: Asy_D01 from Immigration System Statistics

import { BaseIngestor, fetchUrl, parseODS, sheetToJson, getSheetNames } from '../lib/ingest';
import { query, formatDateISO, log, toQuarterEnd } from '../lib/db';

interface ClaimRecord {
  quarter_end: Date;
  year: number;
  quarter: number;
  nationality_name: string;
  claims_main_applicant: number;
  claims_dependants: number;
  claims_total: number;
  claims_in_country: number;
  claims_at_port: number;
}

export class AsylumClaimsIngestor extends BaseIngestor {
  constructor() {
    super('ASY_D01');
  }

  protected async fetch(): Promise<Buffer> {
    // Main asylum statistics ODS file
    const url = 'https://assets.publishing.service.gov.uk/media/6714906d30536cb9274830b3/asylum-applications-datasets-sep-2024.ods';
    return fetchUrl(url);
  }

  protected async parse(buffer: Buffer): Promise<ClaimRecord[]> {
    const workbook = parseODS(buffer);
    const sheetNames = getSheetNames(workbook);
    
    log('info', 'Found sheets in asylum claims file', { sheets: sheetNames });
    
    // Find the claims by nationality sheet
    const claimsSheetName = sheetNames.find(s => 
      s.toLowerCase().includes('asy_d01') || 
      s.toLowerCase().includes('application') ||
      s.toLowerCase().includes('claim')
    );

    if (!claimsSheetName) {
      throw new Error('Could not find claims sheet in asylum data');
    }

    return this.parseSheet(workbook, claimsSheetName);
  }

  private parseSheet(workbook: any, sheetName: string): ClaimRecord[] {
    const rows = sheetToJson<Record<string, any>>(workbook, sheetName);
    const results: ClaimRecord[] = [];
    
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
      total: keys.find(k => 
        k.toLowerCase().includes('total') && 
        k.toLowerCase().includes('application')
      ) || keys.find(k => k.toLowerCase() === 'total'),
      main_applicant: keys.find(k => 
        k.toLowerCase().includes('main') ||
        k.toLowerCase().includes('principal')
      ),
      dependants: keys.find(k => 
        k.toLowerCase().includes('dependant')
      ),
      in_country: keys.find(k => 
        k.toLowerCase().includes('in_country') ||
        k.toLowerCase().includes('after_entry')
      ),
      at_port: keys.find(k => 
        k.toLowerCase().includes('port') ||
        k.toLowerCase().includes('on_entry')
      ),
    };

    log('info', 'Column mappings for claims', { columnMap });

    for (const row of rows) {
      if (!columnMap.nationality || !row[columnMap.nationality]) continue;
      
      const nationality = String(row[columnMap.nationality]).trim();
      
      // Skip invalid entries
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

      const record: ClaimRecord = {
        quarter_end: toQuarterEnd(year, quarter),
        year,
        quarter,
        nationality_name: nationality,
        claims_main_applicant: parseNum(columnMap.main_applicant),
        claims_dependants: parseNum(columnMap.dependants),
        claims_total: parseNum(columnMap.total),
        claims_in_country: parseNum(columnMap.in_country),
        claims_at_port: parseNum(columnMap.at_port),
      };

      // Calculate total if not present
      if (record.claims_total === 0 && (record.claims_main_applicant > 0 || record.claims_dependants > 0)) {
        record.claims_total = record.claims_main_applicant + record.claims_dependants;
      }

      if (record.claims_total > 0) {
        results.push(record);
      }
    }

    return results;
  }

  protected async load(data: ClaimRecord[]): Promise<void> {
    for (const record of data) {
      const nationalityId = await this.getNationalityId(record.nationality_name);

      await query(
        `INSERT INTO asylum_claims (
          quarter_end, year, quarter, nationality_id, nationality_name,
          claims_main_applicant, claims_dependants, claims_total,
          claims_in_country, claims_at_port, ingest_run_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT DO NOTHING`,
        [
          formatDateISO(record.quarter_end),
          record.year,
          record.quarter,
          nationalityId,
          record.nationality_name,
          record.claims_main_applicant,
          record.claims_dependants,
          record.claims_total,
          record.claims_in_country,
          record.claims_at_port,
          this.runId,
        ]
      );
      this.recordsInserted++;
    }
  }
}
