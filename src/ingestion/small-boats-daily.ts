// Small Boat Arrivals - Daily HTML Scraper
// Source: https://www.gov.uk/government/publications/migrants-detected-crossing-the-english-channel-in-small-boats

import { BaseIngestor, fetchHtml, parseHtml } from '../lib/ingest';
import { upsertOne, formatDateISO, parseUKDate, log } from '../lib/db';

interface DailyArrival {
  date: Date;
  arrivals: number;
  boats?: number;
  people_per_boat?: number;
}

export class SmallBoatDailyIngestor extends BaseIngestor {
  constructor() {
    super('SBA_DAILY');
  }

  protected async fetch(): Promise<string> {
    // Main page with latest 7 days
    const url = 'https://www.gov.uk/government/publications/migrants-detected-crossing-the-english-channel-in-small-boats/migrants-detected-crossing-the-english-channel-in-small-boats-last-7-days';
    return fetchHtml(url);
  }

  protected async parse(html: string): Promise<DailyArrival[]> {
    const $ = parseHtml(html);
    const arrivals: DailyArrival[] = [];

    // The page typically has a table or structured data with recent arrivals
    // Structure varies but usually contains date and number of arrivals
    
    // Try to find the main content table
    $('table').each((_: number, table: any) => {
      const rows = $(table).find('tr');
      
      rows.each((rowIndex: number, row: any) => {
        if (rowIndex === 0) return; // Skip header
        
        const cells = $(row).find('td');
        if (cells.length >= 2) {
          const dateText = $(cells[0]).text().trim();
          const arrivalsText = $(cells[1]).text().trim().replace(/,/g, '');
          
          const date = parseUKDate(dateText);
          const count = parseInt(arrivalsText, 10);
          
          if (date && !isNaN(count)) {
            const arrival: DailyArrival = {
              date,
              arrivals: count,
            };
            
            // Check for boats column
            if (cells.length >= 3) {
              const boatsText = $(cells[2]).text().trim().replace(/,/g, '');
              const boats = parseInt(boatsText, 10);
              if (!isNaN(boats)) {
                arrival.boats = boats;
                arrival.people_per_boat = boats > 0 ? Math.round((count / boats) * 10) / 10 : undefined;
              }
            }
            
            arrivals.push(arrival);
          }
        }
      });
    });

    // Alternative: look for structured content in divs/paragraphs
    if (arrivals.length === 0) {
      // Sometimes data is in paragraphs or definition lists
      const content = $('.govuk-body, .gem-c-govspeak').text();
      
      // Pattern: "On [date], [number] people were detected"
      const pattern = /On\s+(\d{1,2}\s+\w+\s+\d{4})[,.]?\s*(\d+(?:,\d{3})*)\s+people/gi;
      let match;
      
      while ((match = pattern.exec(content)) !== null) {
        const date = parseUKDate(match[1]);
        const count = parseInt(match[2].replace(/,/g, ''), 10);
        
        if (date && !isNaN(count)) {
          arrivals.push({ date, arrivals: count });
        }
      }
    }

    // Also try to extract from the "last 7 days" summary
    const summarySection = $('.gem-c-govspeak, .govuk-body-l').text();
    const ytdMatch = summarySection.match(/(\d{1,3}(?:,\d{3})*)\s+people.*?this year/i);
    
    if (ytdMatch) {
      log('info', 'Found YTD total', { ytd: ytdMatch[1] });
    }

    return arrivals;
  }

  protected async load(data: DailyArrival[]): Promise<void> {
    for (const arrival of data) {
      await upsertOne(
        'small_boat_arrivals_daily',
        {
          date: formatDateISO(arrival.date),
          arrivals: arrival.arrivals,
          boats: arrival.boats,
          people_per_boat: arrival.people_per_boat,
          source_url: this.source?.url,
          scraped_at: new Date(),
        },
        ['date']
      );
      this.recordsInserted++;
    }
  }
}

// =============================================================================
// MANUAL ENTRY HELPER (for days when scraping fails)
// =============================================================================

export async function addManualDailyEntry(
  date: Date,
  arrivals: number,
  boats?: number
): Promise<void> {
  await upsertOne(
    'small_boat_arrivals_daily',
    {
      date: formatDateISO(date),
      arrivals,
      boats,
      people_per_boat: boats && boats > 0 ? Math.round((arrivals / boats) * 10) / 10 : null,
      source_url: 'manual_entry',
      scraped_at: new Date(),
    },
    ['date']
  );
}
