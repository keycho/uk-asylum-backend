// Auto-Insights Generator
// Generates analytical insights from the data for display on dashboard

import { query, getMany, formatDateISO, log } from '../src/lib/db';

interface InsightCandidate {
  type: string;
  subject: string;
  metric: string;
  headline: string;
  detail: string;
  magnitude: number;
}

async function generateInsights(): Promise<void> {
  log('info', 'Starting insights generation');
  
  const candidates: InsightCandidate[] = [];
  
  // ==========================================================================
  // LA OUTLIER INSIGHTS
  // ==========================================================================
  
  // Find LAs with highest per-capita asylum support
  const highPerCapita = await getMany<{ la_name: string; per_10k: number; national_avg: number }>(`
    WITH national_avg AS (
      SELECT AVG(per_10k_population) as avg_per_10k
      FROM asylum_support_la
      WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM asylum_support_la)
        AND per_10k_population IS NOT NULL
    )
    SELECT 
      la_name,
      per_10k_population as per_10k,
      (SELECT avg_per_10k FROM national_avg) as national_avg
    FROM asylum_support_la
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM asylum_support_la)
      AND per_10k_population > (SELECT avg_per_10k * 3 FROM national_avg)
    ORDER BY per_10k_population DESC
    LIMIT 10
  `);

  for (const la of highPerCapita) {
    const multiple = Math.round((la.per_10k / la.national_avg) * 10) / 10;
    candidates.push({
      type: 'la_outlier',
      subject: la.la_name,
      metric: 'per_10k_population',
      headline: `${la.la_name} has ${multiple}× the national average asylum support density`,
      detail: `${la.per_10k.toFixed(1)} per 10,000 vs national average of ${la.national_avg.toFixed(1)}`,
      magnitude: multiple,
    });
  }

  // Find LAs with highest hotel share
  const highHotelShare = await getMany<{ la_name: string; hotel_pct: number; hotel: number }>(`
    SELECT 
      la_name,
      hotel_share_pct as hotel_pct,
      hotel
    FROM asylum_support_la
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM asylum_support_la)
      AND total_supported >= 100
      AND hotel_share_pct > 50
    ORDER BY hotel_share_pct DESC
    LIMIT 10
  `);

  for (const la of highHotelShare) {
    candidates.push({
      type: 'la_outlier',
      subject: la.la_name,
      metric: 'hotel_share_pct',
      headline: `${la.la_name}: ${la.hotel_pct.toFixed(0)}% in hotels (${la.hotel.toLocaleString()} people)`,
      detail: `Higher hotel reliance indicates pressure on dispersed accommodation`,
      magnitude: la.hotel_pct,
    });
  }

  // Find LAs with fastest growth
  const fastestGrowth = await getMany<{ la_name: string; qoq_change: number; total: number }>(`
    SELECT 
      la_name,
      qoq_change_pct as qoq_change,
      total_supported as total
    FROM asylum_support_la
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM asylum_support_la)
      AND total_supported >= 50
      AND qoq_change_pct > 20
    ORDER BY qoq_change_pct DESC
    LIMIT 10
  `);

  for (const la of fastestGrowth) {
    candidates.push({
      type: 'trend',
      subject: la.la_name,
      metric: 'qoq_change',
      headline: `${la.la_name} up ${la.qoq_change.toFixed(0)}% quarter-over-quarter`,
      detail: `Now hosting ${la.total.toLocaleString()} asylum seekers`,
      magnitude: la.qoq_change,
    });
  }

  // ==========================================================================
  // NATIONAL TREND INSIGHTS
  // ==========================================================================
  
  // Backlog trend
  const backlogTrend = await getMany<{ snapshot_date: Date; total: number }>(`
    SELECT snapshot_date, total_awaiting as total
    FROM asylum_backlog
    ORDER BY snapshot_date DESC
    LIMIT 4
  `);

  if (backlogTrend.length >= 2) {
    const current = backlogTrend[0];
    const previous = backlogTrend[1];
    const change = current.total - previous.total;
    const changePct = Math.round((change / previous.total) * 100);
    
    if (Math.abs(changePct) >= 5) {
      candidates.push({
        type: 'trend',
        subject: 'National Backlog',
        metric: 'backlog_total',
        headline: `Asylum backlog ${change > 0 ? 'up' : 'down'} ${Math.abs(changePct)}% to ${current.total.toLocaleString()}`,
        detail: `Changed by ${Math.abs(change).toLocaleString()} from previous quarter`,
        magnitude: Math.abs(changePct),
      });
    }
  }

  // Small boat YTD comparison
  const ytdComparison = await getMany<{ year: number; ytd: number }>(`
    SELECT year, ytd_arrivals as ytd
    FROM small_boat_arrivals_weekly
    WHERE week_number = (
      SELECT MAX(week_number) 
      FROM small_boat_arrivals_weekly 
      WHERE year = EXTRACT(YEAR FROM CURRENT_DATE)
    )
    ORDER BY year DESC
    LIMIT 2
  `);

  if (ytdComparison.length >= 2) {
    const current = ytdComparison[0];
    const previous = ytdComparison[1];
    const change = current.ytd - previous.ytd;
    const changePct = Math.round((change / previous.ytd) * 100);
    
    candidates.push({
      type: 'comparison',
      subject: 'Small Boat Arrivals',
      metric: 'ytd_arrivals',
      headline: `${current.year} arrivals ${change > 0 ? 'up' : 'down'} ${Math.abs(changePct)}% vs same point in ${previous.year}`,
      detail: `${current.ytd.toLocaleString()} YTD vs ${previous.ytd.toLocaleString()} last year`,
      magnitude: Math.abs(changePct),
    });
  }

  // ==========================================================================
  // GRANT RATE INSIGHTS
  // ==========================================================================
  
  const grantRateExtremes = await getMany<{ nationality: string; rate: number; decisions: number }>(`
    SELECT 
      nationality_name as nationality,
      grant_rate_pct as rate,
      decisions_total as decisions
    FROM asylum_decisions
    WHERE quarter_end = (SELECT MAX(quarter_end) FROM asylum_decisions)
      AND decisions_total >= 100
    ORDER BY grant_rate_pct DESC
    LIMIT 5
  `);

  for (const nat of grantRateExtremes) {
    if (nat.rate >= 80) {
      candidates.push({
        type: 'comparison',
        subject: nat.nationality,
        metric: 'grant_rate',
        headline: `${nat.nationality}: ${nat.rate.toFixed(0)}% grant rate (${nat.decisions.toLocaleString()} decisions)`,
        detail: `One of the highest recognition rates this quarter`,
        magnitude: nat.rate,
      });
    }
  }

  // ==========================================================================
  // SPENDING INSIGHTS
  // ==========================================================================
  
  const spendingTrend = await getMany<{ fy: string; total: number; hotel: number }>(`
    SELECT 
      financial_year as fy,
      total_spend_millions as total,
      hotel_spend as hotel
    FROM spending_annual
    ORDER BY financial_year DESC
    LIMIT 2
  `);

  if (spendingTrend.length >= 2) {
    const current = spendingTrend[0];
    const previous = spendingTrend[1];
    
    if (current.total && previous.total) {
      const change = current.total - previous.total;
      const changePct = Math.round((change / previous.total) * 100);
      
      candidates.push({
        type: 'trend',
        subject: 'Asylum Spending',
        metric: 'total_spend',
        headline: `Asylum spending ${change > 0 ? 'up' : 'down'} ${Math.abs(changePct)}% to £${current.total.toFixed(1)}B`,
        detail: `FY ${current.fy} vs FY ${previous.fy}`,
        magnitude: Math.abs(current.total),
      });
      
      if (current.hotel && current.total) {
        const hotelPct = Math.round((current.hotel / current.total) * 100);
        candidates.push({
          type: 'comparison',
          subject: 'Hotel Spending',
          metric: 'hotel_share',
          headline: `Hotels now ${hotelPct}% of total asylum spend (£${current.hotel.toFixed(1)}B)`,
          detail: `Hotel accommodation is the single largest cost driver`,
          magnitude: hotelPct,
        });
      }
    }
  }

  // ==========================================================================
  // PERSIST INSIGHTS
  // ==========================================================================
  
  // Clear old insights
  await query(`DELETE FROM auto_insights WHERE generated_date < CURRENT_DATE - INTERVAL '7 days'`);
  
  // Insert new insights
  const today = formatDateISO(new Date());
  let inserted = 0;
  
  for (const insight of candidates) {
    await query(
      `INSERT INTO auto_insights (generated_date, insight_type, subject, metric, headline, detail, magnitude, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE + INTERVAL '7 days')
       ON CONFLICT DO NOTHING`,
      [today, insight.type, insight.subject, insight.metric, insight.headline, insight.detail, insight.magnitude]
    );
    inserted++;
  }
  
  log('info', `Generated ${inserted} insights`);
}

// Run if called directly
generateInsights()
  .then(() => {
    log('info', 'Insights generation complete');
    process.exit(0);
  })
  .catch((error) => {
    log('error', 'Insights generation failed', { error: String(error) });
    process.exit(1);
  });
