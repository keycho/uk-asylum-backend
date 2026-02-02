// Asylum Support by Local Authority - Quarterly ODS Parser
// Source: Asy_D11 from Immigration System Statistics
// URL: https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables

import { BaseIngestor, fetchUrl, parseODS, sheetToJson, getSheetNames } from '../lib/ingest';
import { query, bulkUpsert, formatDateISO, log, getOne } from '../lib/db';

interface LASupport {
  snapshot_date: Date;
  la_name: string;
  region: string;
  total_supported: number;
  section_95: number;
  section_4: number;
  section_98: number;
  dispersed: number;
  initial_accommodation: number;
  hotel: number;
  subsistence_only: number;
  main_applicants: number;
  dependants: number;
}

export class AsylumSupportLAIngestor extends BaseIngestor {
  constructor() {
    super('ASY_D11');
  }

  protected async fetch(): Promise<Buffer> {
    // The main immigration statistics data tables ODS
    // Note: This URL may need updating when new releases are published
    const url = 'https://assets.publishing.service.gov.uk/media/67148c4930536cb927482c15/asylum-support-datasets-sep-2024.ods';
    
    // Alternative: Use the discovery page to find the latest
    // https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables
    
    return fetchUrl(url);
  }

  protected async parse(buffer: Buffer): Promise<LASupport[]> {
    const workbook = parseODS(buffer);
    const sheetNames = getSheetNames(workbook);
    
    log('info', 'Found sheets in asylum support file', { sheets: sheetNames });
    
    // Find the LA-level sheet (usually "Asy_D11" or contains "local_authority")
    const laSheetName = sheetNames.find(s => 
      s.toLowerCase().includes('asy_d11') || 
      s.toLowerCase().includes('local_authority') ||
      s.toLowerCase().includes('la_level') ||
      s.toLowerCase().includes('la ')
    );

    if (!laSheetName) {
      // Try to find any sheet with LA data
      for (const sheetName of sheetNames) {
        const rows = sheetToJson<Record<string, any>>(workbook, sheetName);
        if (rows.length > 0) {
          const firstRow = rows[0];
          const keys = Object.keys(firstRow);
          if (keys.some(k => k.toLowerCase().includes('authority') || k.toLowerCase().includes('council'))) {
            return this.parseSheet(workbook, sheetName);
          }
        }
      }
      throw new Error('Could not find LA-level sheet in asylum support data');
    }

    return this.parseSheet(workbook, laSheetName);
  }

  private parseSheet(workbook: any, sheetName: string): LASupport[] {
    const rows = sheetToJson<Record<string, any>>(workbook, sheetName);
    const results: LASupport[] = [];
    
    log('info', `Parsing sheet ${sheetName}`, { rowCount: rows.length });

    // Detect column mappings
    if (rows.length === 0) return results;
    
    const sampleRow = rows[0];
    const keys = Object.keys(sampleRow);
    
    // Map column names to our fields
    const columnMap = {
      la_name: keys.find(k => 
        k.toLowerCase().includes('authority') || 
        k.toLowerCase().includes('council') ||
        k.toLowerCase().includes('la_name') ||
        k.toLowerCase() === 'la'
      ),
      region: keys.find(k => 
        k.toLowerCase().includes('region') ||
        k.toLowerCase().includes('area')
      ),
      total: keys.find(k => 
        k.toLowerCase().includes('total') && 
        !k.toLowerCase().includes('sub')
      ),
      section_95: keys.find(k => 
        k.toLowerCase().includes('section_95') || 
        k.toLowerCase().includes('s95') ||
        (k.toLowerCase().includes('95') && k.toLowerCase().includes('section'))
      ),
      section_4: keys.find(k => 
        k.toLowerCase().includes('section_4') || 
        k.toLowerCase().includes('s4') ||
        (k.toLowerCase().includes('4') && k.toLowerCase().includes('section'))
      ),
      dispersed: keys.find(k => 
        k.toLowerCase().includes('dispersed')
      ),
      initial: keys.find(k => 
        k.toLowerCase().includes('initial')
      ),
      hotel: keys.find(k => 
        k.toLowerCase().includes('hotel') ||
        k.toLowerCase().includes('contingency')
      ),
      subsistence: keys.find(k => 
        k.toLowerCase().includes('subsistence')
      ),
      main_applicant: keys.find(k => 
        k.toLowerCase().includes('main') ||
        k.toLowerCase().includes('applicant')
      ),
      dependants: keys.find(k => 
        k.toLowerCase().includes('dependant')
      ),
      date: keys.find(k => 
        k.toLowerCase().includes('date') ||
        k.toLowerCase().includes('quarter') ||
        k.toLowerCase().includes('period')
      ),
    };

    log('info', 'Column mappings detected', { columnMap });

    // Determine snapshot date from filename or content
    // Format is usually "As at [date]" or embedded in the data
    let snapshotDate = new Date();
    
    // Try to extract from data
    for (const row of rows) {
      if (columnMap.date && row[columnMap.date]) {
        const dateVal = row[columnMap.date];
        if (typeof dateVal === 'number') {
          // Excel serial date
          snapshotDate = new Date((dateVal - 25569) * 86400 * 1000);
        } else if (typeof dateVal === 'string') {
          // Try parsing
          const parsed = new Date(dateVal);
          if (!isNaN(parsed.getTime())) {
            snapshotDate = parsed;
          }
        }
        break;
      }
    }

    // Parse each row
    for (const row of rows) {
      if (!columnMap.la_name || !row[columnMap.la_name]) continue;
      
      const laName = String(row[columnMap.la_name]).trim();
      
      // Skip header rows, totals, and invalid entries
      if (
        laName.toLowerCase().includes('total') ||
        laName.toLowerCase().includes('unknown') ||
        laName.toLowerCase() === 'la' ||
        laName.toLowerCase() === 'local authority' ||
        laName.length < 3
      ) continue;

      const parseNum = (key: string | undefined): number => {
        if (!key || !row[key]) return 0;
        const val = row[key];
        if (typeof val === 'number') return val;
        const parsed = parseInt(String(val).replace(/[^0-9-]/g, ''), 10);
        return isNaN(parsed) ? 0 : parsed;
      };

      const record: LASupport = {
        snapshot_date: snapshotDate,
        la_name: laName,
        region: columnMap.region ? String(row[columnMap.region] || '').trim() : '',
        total_supported: parseNum(columnMap.total),
        section_95: parseNum(columnMap.section_95),
        section_4: parseNum(columnMap.section_4),
        section_98: 0, // Often not broken out
        dispersed: parseNum(columnMap.dispersed),
        initial_accommodation: parseNum(columnMap.initial),
        hotel: parseNum(columnMap.hotel),
        subsistence_only: parseNum(columnMap.subsistence),
        main_applicants: parseNum(columnMap.main_applicant),
        dependants: parseNum(columnMap.dependants),
      };

      // If total is 0 but we have components, calculate it
      if (record.total_supported === 0) {
        record.total_supported = record.section_95 + record.section_4 + record.section_98;
      }

      // Only include if there's actual data
      if (record.total_supported > 0 || record.dispersed > 0 || record.hotel > 0) {
        results.push(record);
      }
    }

    log('info', `Parsed ${results.length} LA records`);
    return results;
  }

  protected async load(data: LASupport[]): Promise<void> {
    for (const record of data) {
      // Look up LA ID
      const laId = await this.getLAId(record.la_name);
      
      // If LA doesn't exist, create a stub entry
      let finalLaId = laId;
      if (!finalLaId) {
        const insertResult = await query(
          `INSERT INTO local_authorities (ons_code, name, name_normalized, region)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (ons_code) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [
            `STUB_${record.la_name.substring(0, 20).replace(/\s/g, '_').toUpperCase()}`,
            record.la_name,
            record.la_name.toLowerCase().trim(),
            record.region,
          ]
        );
        finalLaId = insertResult.rows[0]?.id;
      }

      await query(
        `INSERT INTO asylum_support_la (
          snapshot_date, la_id, la_name, region,
          total_supported, section_95, section_4, section_98,
          dispersed, initial_accommodation, hotel, subsistence_only,
          main_applicants, dependants, ingest_run_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT DO NOTHING`,
        [
          formatDateISO(record.snapshot_date),
          finalLaId,
          record.la_name,
          record.region,
          record.total_supported,
          record.section_95,
          record.section_4,
          record.section_98,
          record.dispersed,
          record.initial_accommodation,
          record.hotel,
          record.subsistence_only,
          record.main_applicants,
          record.dependants,
          this.runId,
        ]
      );
      this.recordsInserted++;
    }

    // Trigger calculation of derived metrics
    await this.calculateDerivedMetrics(data[0]?.snapshot_date);
  }

  private async calculateDerivedMetrics(snapshotDate?: Date): Promise<void> {
    if (!snapshotDate) return;

    const dateStr = formatDateISO(snapshotDate);

    // Update per_10k_population
    await query(`
      UPDATE asylum_support_la asl
      SET per_10k_population = ROUND((asl.total_supported::DECIMAL / la.population) * 10000, 2)
      FROM local_authorities la
      WHERE asl.la_id = la.id 
        AND asl.snapshot_date = $1
        AND la.population > 0
    `, [dateStr]);

    // Update national_share_pct
    const totalResult = await getOne<{ total: number }>(
      'SELECT SUM(total_supported) as total FROM asylum_support_la WHERE snapshot_date = $1',
      [dateStr]
    );
    
    if (totalResult && totalResult.total > 0) {
      await query(`
        UPDATE asylum_support_la
        SET national_share_pct = ROUND((total_supported::DECIMAL / $1) * 100, 2)
        WHERE snapshot_date = $2
      `, [totalResult.total, dateStr]);
    }

    // Update hotel_share_pct
    await query(`
      UPDATE asylum_support_la
      SET hotel_share_pct = ROUND((COALESCE(hotel, 0)::DECIMAL / NULLIF(total_supported, 0)) * 100, 2)
      WHERE snapshot_date = $1
    `, [dateStr]);

    log('info', 'Calculated derived metrics for LA support data', { snapshot_date: dateStr });
  }
}
