// Small Boat Arrivals - Weekly ODS Parser
// Source: https://www.gov.uk/government/statistical-data-sets/irregular-migration-detailed-dataset-and-summary-tables

import { BaseIngestor, fetchUrl, parseODS, sheetToJson, getSheetNames } from '../lib/ingest';
import { query, bulkUpsert, formatDateISO, log } from '../lib/db';

interface WeeklyArrival {
  week_ending: Date;
  year: number;
  week_number: number;
  arrivals: number;
  boats: number;
  ytd_arrivals: number;
  ytd_boats: number;
}

interface NationalityArrival {
  period_start: Date;
  period_end: Date;
  period_type: string;
  nationality_name: string;
  arrivals: number;
  share_pct?: number;
}

export class SmallBoatWeeklyIngestor extends BaseIngestor {
  constructor() {
    super('SBA_WEEKLY');
  }

  protected async fetch(): Promise<Buffer> {
    // The actual ODS file URL - this may need updating when new files are published
    const url = 'https://assets.publishing.service.gov.uk/media/683d9157d23a62e5d32680aa/small-boat-arrivals-and-crossing-days-data-tables.ods';
    return fetchUrl(url);
  }

  protected async parse(buffer: Buffer): Promise<{ weekly: WeeklyArrival[]; nationality: NationalityArrival[] }> {
    const workbook = parseODS(buffer);
    const sheetNames = getSheetNames(workbook);
    
    log('info', 'Found sheets', { sheets: sheetNames });
    
    const weekly: WeeklyArrival[] = [];
    const nationality: NationalityArrival[] = [];

    // Find the weekly arrivals sheet (usually named something like "Arrivals_weekly" or "Irr_01")
    const weeklySheetName = sheetNames.find(s => 
      s.toLowerCase().includes('weekly') || 
      s.toLowerCase().includes('irr_01') ||
      s.toLowerCase().includes('time_series')
    );

    if (weeklySheetName) {
      const rows = sheetToJson<Record<string, any>>(workbook, weeklySheetName);
      
      for (const row of rows) {
        // Try to extract week ending date
        const weekEndingKey = Object.keys(row).find(k => 
          k.toLowerCase().includes('week') || 
          k.toLowerCase().includes('date') ||
          k.toLowerCase().includes('period')
        );
        
        const arrivalsKey = Object.keys(row).find(k => 
          k.toLowerCase().includes('arrival') || 
          k.toLowerCase().includes('people') ||
          k.toLowerCase().includes('detected')
        );
        
        const boatsKey = Object.keys(row).find(k => 
          k.toLowerCase().includes('boat') && !k.toLowerCase().includes('per')
        );

        if (weekEndingKey && arrivalsKey) {
          const weekEnding = this.parseExcelDate(row[weekEndingKey]);
          const arrivals = parseInt(String(row[arrivalsKey]).replace(/,/g, ''), 10);
          
          if (weekEnding && !isNaN(arrivals)) {
            const boats = boatsKey ? parseInt(String(row[boatsKey]).replace(/,/g, ''), 10) : 0;
            
            weekly.push({
              week_ending: weekEnding,
              year: weekEnding.getFullYear(),
              week_number: this.getWeekNumber(weekEnding),
              arrivals,
              boats: isNaN(boats) ? 0 : boats,
              ytd_arrivals: 0, // Will calculate after
              ytd_boats: 0,
            });
          }
        }
      }

      // Calculate YTD
      weekly.sort((a, b) => a.week_ending.getTime() - b.week_ending.getTime());
      let currentYear = 0;
      let ytdArrivals = 0;
      let ytdBoats = 0;
      
      for (const week of weekly) {
        if (week.year !== currentYear) {
          currentYear = week.year;
          ytdArrivals = 0;
          ytdBoats = 0;
        }
        ytdArrivals += week.arrivals;
        ytdBoats += week.boats;
        week.ytd_arrivals = ytdArrivals;
        week.ytd_boats = ytdBoats;
      }
    }

    // Find nationality breakdown sheet (usually "Irr_02" or "nationality")
    const nationalitySheetName = sheetNames.find(s => 
      s.toLowerCase().includes('nationality') || 
      s.toLowerCase().includes('irr_02')
    );

    if (nationalitySheetName) {
      const rows = sheetToJson<Record<string, any>>(workbook, nationalitySheetName);
      
      for (const row of rows) {
        const nationalityKey = Object.keys(row).find(k => 
          k.toLowerCase().includes('nationality') || 
          k.toLowerCase().includes('country')
        );
        
        const arrivalsKey = Object.keys(row).find(k => 
          k.toLowerCase().includes('arrival') || 
          k.toLowerCase().includes('total')
        );
        
        const yearKey = Object.keys(row).find(k => 
          k.toLowerCase().includes('year') || 
          k.toLowerCase().includes('period')
        );

        if (nationalityKey && arrivalsKey) {
          const nat = String(row[nationalityKey]).trim();
          const arrivals = parseInt(String(row[arrivalsKey]).replace(/,/g, ''), 10);
          
          if (nat && nat !== 'Total' && !isNaN(arrivals)) {
            const year = yearKey ? parseInt(String(row[yearKey]), 10) : new Date().getFullYear();
            
            nationality.push({
              period_start: new Date(year, 0, 1),
              period_end: new Date(year, 11, 31),
              period_type: 'year',
              nationality_name: nat,
              arrivals,
            });
          }
        }
      }

      // Calculate share percentages
      const yearTotals = new Map<number, number>();
      for (const n of nationality) {
        const year = n.period_end.getFullYear();
        yearTotals.set(year, (yearTotals.get(year) || 0) + n.arrivals);
      }
      
      for (const n of nationality) {
        const year = n.period_end.getFullYear();
        const total = yearTotals.get(year) || 1;
        n.share_pct = Math.round((n.arrivals / total) * 1000) / 10;
      }
    }

    return { weekly, nationality };
  }

  protected async load(data: { weekly: WeeklyArrival[]; nationality: NationalityArrival[] }): Promise<void> {
    // Load weekly data
    if (data.weekly.length > 0) {
      const weeklyRows = data.weekly.map(w => ({
        week_ending: formatDateISO(w.week_ending),
        year: w.year,
        week_number: w.week_number,
        arrivals: w.arrivals,
        boats: w.boats,
        ytd_arrivals: w.ytd_arrivals,
        ytd_boats: w.ytd_boats,
        ingest_run_id: this.runId,
      }));

      const result = await bulkUpsert(
        'small_boat_arrivals_weekly',
        weeklyRows,
        ['week_ending']
      );
      this.recordsInserted += result.inserted;
    }

    // Load nationality data
    if (data.nationality.length > 0) {
      for (const nat of data.nationality) {
        const nationalityId = await this.getNationalityId(nat.nationality_name);
        
        await query(
          `INSERT INTO small_boat_nationality 
           (period_start, period_end, period_type, nationality_id, nationality_name, arrivals, share_pct, ingest_run_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT DO NOTHING`,
          [
            formatDateISO(nat.period_start),
            formatDateISO(nat.period_end),
            nat.period_type,
            nationalityId,
            nat.nationality_name,
            nat.arrivals,
            nat.share_pct,
            this.runId,
          ]
        );
        this.recordsInserted++;
      }
    }
  }

  // =============================================================================
  // HELPERS
  // =============================================================================

  private parseExcelDate(value: any): Date | null {
    if (!value) return null;
    
    // Excel serial date
    if (typeof value === 'number') {
      const date = new Date((value - 25569) * 86400 * 1000);
      return isNaN(date.getTime()) ? null : date;
    }
    
    // String date
    if (typeof value === 'string') {
      const date = new Date(value);
      return isNaN(date.getTime()) ? null : date;
    }
    
    // Already a Date
    if (value instanceof Date) {
      return value;
    }
    
    return null;
  }

  private getWeekNumber(date: Date): number {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  }
}
