// UK Asylum Dashboard - Express API Server
import express, { Request, Response } from 'express';
import cors from 'cors';
import { getOne, getMany, log } from './lib/db';
import { runIngestor, runAllIngestors } from './lib/ingest';
import {
  DashboardSummary,
  AsylumSupportLA,
  SpendingAnnual,
  LocalAuthority,
  AutoInsight,
} from './types';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, _res, next) => {
  log('info', `${req.method} ${req.path}`, { query: req.query });
  next();
});

// =============================================================================
// HEALTH & STATUS
// =============================================================================

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/status', async (_req: Request, res: Response) => {
  try {
    const [sources, lastRun, dbSize] = await Promise.all([
      getMany('SELECT code, name, last_updated, status FROM data_sources ORDER BY last_updated DESC NULLS LAST'),
      getOne('SELECT * FROM ingest_runs ORDER BY started_at DESC LIMIT 1'),
      getOne("SELECT pg_size_pretty(pg_database_size(current_database())) as size"),
    ]);
    
    res.json({
      database_size: dbSize?.size,
      sources,
      last_ingest: lastRun,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// =============================================================================
// DASHBOARD SUMMARY
// =============================================================================

app.get('/api/dashboard/summary', async (_req: Request, res: Response) => {
  try {
    // Get latest asylum support total
    const supportTotal = await getOne<{ total: number; hotel: number; snapshot_date: Date }>(`
      SELECT 
        SUM(total_supported) as total,
        SUM(hotel) as hotel,
        snapshot_date
      FROM asylum_support_la
      WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM asylum_support_la)
      GROUP BY snapshot_date
    `);

    // Get latest spending
    const spending = await getOne<SpendingAnnual>(`
      SELECT * FROM spending_annual 
      ORDER BY financial_year DESC 
      LIMIT 1
    `);

    // Get latest backlog
    const backlog = await getOne<{ total_awaiting: number }>(`
      SELECT total_awaiting FROM asylum_backlog 
      ORDER BY snapshot_date DESC 
      LIMIT 1
    `);

    // Get YTD small boat arrivals
    const ytdArrivals = await getOne<{ ytd: number }>(`
      SELECT ytd_arrivals as ytd FROM small_boat_arrivals_weekly 
      ORDER BY week_ending DESC 
      LIMIT 1
    `);

    // Get YTD decisions and average grant rate
    const decisionStats = await getOne<{ total_decisions: number; avg_grant_rate: number }>(`
      SELECT 
        SUM(decisions_total) as total_decisions,
        ROUND(AVG(grant_rate_pct)::numeric, 1) as avg_grant_rate
      FROM asylum_decisions
      WHERE quarter_end >= DATE_TRUNC('year', CURRENT_DATE)
    `);

    const summary: DashboardSummary = {
      total_supported: supportTotal?.total || 0,
      total_spend_millions: spending?.total_spend_millions || 0,
      backlog_total: backlog?.total_awaiting || 0,
      hotel_population: supportTotal?.hotel || 0,
      hotel_share_pct: supportTotal?.total && supportTotal?.hotel 
        ? Math.round((supportTotal.hotel / supportTotal.total) * 1000) / 10 
        : 0,
      ytd_small_boat_arrivals: ytdArrivals?.ytd || 0,
      ytd_decisions: decisionStats?.total_decisions || 0,
      avg_grant_rate_pct: decisionStats?.avg_grant_rate || 0,
      last_updated: supportTotal?.snapshot_date || new Date(),
    };

    res.json(summary);
  } catch (error) {
    log('error', 'Failed to get dashboard summary', { error: String(error) });
    res.status(500).json({ error: 'Failed to get dashboard summary' });
  }
});

// =============================================================================
// LOCAL AUTHORITY DATA
// =============================================================================

// Get all LAs with latest support data
app.get('/api/la', async (req: Request, res: Response) => {
  try {
    const { region, sort = 'total_supported', order = 'desc', limit = 500 } = req.query;
    
    let whereClause = 'WHERE asl.snapshot_date = (SELECT MAX(snapshot_date) FROM asylum_support_la)';
    const params: any[] = [];
    
    if (region) {
      params.push(region);
      whereClause += ` AND asl.region = $${params.length}`;
    }

    const sortColumn = ['total_supported', 'per_10k_population', 'hotel_share_pct', 'qoq_change_pct', 'la_name']
      .includes(String(sort)) ? sort : 'total_supported';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

    params.push(Number(limit) || 500);

    const data = await getMany<AsylumSupportLA & { ons_code: string; population: number; centroid_lat: number; centroid_lng: number }>(`
      SELECT 
        asl.*,
        la.ons_code,
        la.population,
        la.imd_rank,
        la.centroid_lat,
        la.centroid_lng
      FROM asylum_support_la asl
      LEFT JOIN local_authorities la ON asl.la_id = la.id
      ${whereClause}
      ORDER BY ${sortColumn} ${sortOrder} NULLS LAST
      LIMIT $${params.length}
    `, params);

    res.json(data);
  } catch (error) {
    log('error', 'Failed to get LA data', { error: String(error) });
    res.status(500).json({ error: 'Failed to get LA data' });
  }
});

// Get single LA detail with history
app.get('/api/la/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Get LA info
    const la = await getOne<LocalAuthority>(
      'SELECT * FROM local_authorities WHERE id = $1 OR ons_code = $1',
      [id]
    );

    if (!la) {
      res.status(404).json({ error: 'Local authority not found' });
      return;
    }

    // Get current support
    const currentSupport = await getOne<AsylumSupportLA>(`
      SELECT * FROM asylum_support_la 
      WHERE la_id = $1 
      ORDER BY snapshot_date DESC 
      LIMIT 1
    `, [la.id]);

    // Get historical support (last 8 quarters)
    const historicalSupport = await getMany<AsylumSupportLA>(`
      SELECT * FROM asylum_support_la 
      WHERE la_id = $1 
      ORDER BY snapshot_date DESC 
      LIMIT 8
    `, [la.id]);

    // Get any auto-generated insights for this LA
    const insights = await getMany<AutoInsight>(`
      SELECT * FROM auto_insights 
      WHERE subject = $1 
        AND (expires_at IS NULL OR expires_at > CURRENT_DATE)
      ORDER BY magnitude DESC 
      LIMIT 5
    `, [la.name]);

    res.json({
      la,
      current_support: currentSupport,
      historical_support: historicalSupport,
      insights,
    });
  } catch (error) {
    log('error', 'Failed to get LA detail', { error: String(error) });
    res.status(500).json({ error: 'Failed to get LA detail' });
  }
});

// Get LA boundaries GeoJSON for map
app.get('/api/la/geojson', async (_req: Request, res: Response) => {
  try {
    const data = await getMany<{ ons_code: string; name: string; geojson: any; total_supported: number; per_10k: number }>(`
      SELECT 
        la.ons_code,
        la.name,
        la.geojson,
        COALESCE(asl.total_supported, 0) as total_supported,
        COALESCE(asl.per_10k_population, 0) as per_10k
      FROM local_authorities la
      LEFT JOIN asylum_support_la asl ON la.id = asl.la_id 
        AND asl.snapshot_date = (SELECT MAX(snapshot_date) FROM asylum_support_la)
      WHERE la.geojson IS NOT NULL
    `);

    // Convert to GeoJSON FeatureCollection
    const featureCollection = {
      type: 'FeatureCollection',
      features: data.map(d => ({
        type: 'Feature',
        properties: {
          ons_code: d.ons_code,
          name: d.name,
          total_supported: d.total_supported,
          per_10k: d.per_10k,
        },
        geometry: d.geojson,
      })),
    };

    res.json(featureCollection);
  } catch (error) {
    log('error', 'Failed to get LA GeoJSON', { error: String(error) });
    res.status(500).json({ error: 'Failed to get LA GeoJSON' });
  }
});

// Get regions summary
app.get('/api/regions', async (_req: Request, res: Response) => {
  try {
    const data = await getMany(`
      SELECT 
        region,
        SUM(total_supported) as total_supported,
        SUM(hotel) as hotel_population,
        SUM(dispersed) as dispersed_population,
        COUNT(*) as la_count,
        ROUND(AVG(per_10k_population)::numeric, 2) as avg_per_10k
      FROM asylum_support_la
      WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM asylum_support_la)
        AND region IS NOT NULL AND region != ''
      GROUP BY region
      ORDER BY total_supported DESC
    `);

    res.json(data);
  } catch (error) {
    log('error', 'Failed to get regions', { error: String(error) });
    res.status(500).json({ error: 'Failed to get regions' });
  }
});

// =============================================================================
// SMALL BOAT ARRIVALS
// =============================================================================

// Get daily arrivals (last N days)
app.get('/api/small-boats/daily', async (req: Request, res: Response) => {
  try {
    const { days = 30 } = req.query;
    
    const data = await getMany(`
      SELECT * FROM small_boat_arrivals_daily 
      ORDER BY date DESC 
      LIMIT $1
    `, [Number(days) || 30]);

    res.json(data.reverse()); // Return chronological order
  } catch (error) {
    log('error', 'Failed to get daily arrivals', { error: String(error) });
    res.status(500).json({ error: 'Failed to get daily arrivals' });
  }
});

// Get weekly time series
app.get('/api/small-boats/weekly', async (req: Request, res: Response) => {
  try {
    const { year } = req.query;
    
    let whereClause = '';
    const params: any[] = [];
    
    if (year) {
      params.push(Number(year));
      whereClause = 'WHERE year = $1';
    }

    const data = await getMany(`
      SELECT * FROM small_boat_arrivals_weekly 
      ${whereClause}
      ORDER BY week_ending DESC
    `, params);

    res.json(data.reverse());
  } catch (error) {
    log('error', 'Failed to get weekly arrivals', { error: String(error) });
    res.status(500).json({ error: 'Failed to get weekly arrivals' });
  }
});

// Get arrivals by nationality
app.get('/api/small-boats/nationality', async (req: Request, res: Response) => {
  try {
    const { year, limit = 20 } = req.query;
    
    let whereClause = '';
    const params: any[] = [Number(limit) || 20];
    
    if (year) {
      params.push(Number(year));
      whereClause = `WHERE EXTRACT(YEAR FROM period_end) = $${params.length}`;
    }

    const data = await getMany(`
      SELECT 
        nationality_name,
        SUM(arrivals) as total_arrivals,
        ROUND(AVG(share_pct)::numeric, 1) as avg_share_pct
      FROM small_boat_nationality
      ${whereClause}
      GROUP BY nationality_name
      ORDER BY total_arrivals DESC
      LIMIT $1
    `, params);

    res.json(data);
  } catch (error) {
    log('error', 'Failed to get arrivals by nationality', { error: String(error) });
    res.status(500).json({ error: 'Failed to get arrivals by nationality' });
  }
});

// =============================================================================
// ASYLUM CLAIMS & DECISIONS
// =============================================================================

// Get grant rates by nationality
app.get('/api/grant-rates', async (req: Request, res: Response) => {
  try {
    const { min_decisions = 50, quarter } = req.query;
    
    let whereClause = 'WHERE decisions_total >= $1';
    const params: any[] = [Number(min_decisions) || 50];
    
    if (quarter) {
      params.push(quarter);
      whereClause += ` AND quarter_end = $${params.length}`;
    } else {
      // Default to latest quarter
      whereClause += ` AND quarter_end = (SELECT MAX(quarter_end) FROM asylum_decisions)`;
    }

    const data = await getMany(`
      SELECT * FROM asylum_decisions
      ${whereClause}
      ORDER BY grant_rate_pct DESC
    `, params);

    res.json(data);
  } catch (error) {
    log('error', 'Failed to get grant rates', { error: String(error) });
    res.status(500).json({ error: 'Failed to get grant rates' });
  }
});

// Get claims time series
app.get('/api/claims/timeseries', async (req: Request, res: Response) => {
  try {
    const { nationality } = req.query;
    
    let whereClause = '';
    const params: any[] = [];
    
    if (nationality) {
      params.push(nationality);
      whereClause = 'WHERE nationality_name = $1';
    }

    const data = await getMany(`
      SELECT 
        quarter_end as date,
        ${nationality ? 'claims_total' : 'SUM(claims_total)'} as value,
        ${nationality ? "nationality_name as label" : "'All nationalities' as label"}
      FROM asylum_claims
      ${whereClause}
      ${nationality ? '' : 'GROUP BY quarter_end'}
      ORDER BY quarter_end
    `, params);

    res.json(data);
  } catch (error) {
    log('error', 'Failed to get claims timeseries', { error: String(error) });
    res.status(500).json({ error: 'Failed to get claims timeseries' });
  }
});

// Get backlog time series
app.get('/api/backlog/timeseries', async (_req: Request, res: Response) => {
  try {
    const data = await getMany(`
      SELECT 
        snapshot_date as date,
        total_awaiting as value,
        'Backlog' as label
      FROM asylum_backlog
      ORDER BY snapshot_date
    `);

    res.json(data);
  } catch (error) {
    log('error', 'Failed to get backlog timeseries', { error: String(error) });
    res.status(500).json({ error: 'Failed to get backlog timeseries' });
  }
});

// =============================================================================
// SPENDING DATA
// =============================================================================

app.get('/api/spending', async (_req: Request, res: Response) => {
  try {
    const data = await getMany<SpendingAnnual>(`
      SELECT * FROM spending_annual
      ORDER BY financial_year
    `);

    res.json(data);
  } catch (error) {
    log('error', 'Failed to get spending data', { error: String(error) });
    res.status(500).json({ error: 'Failed to get spending data' });
  }
});

app.get('/api/spending/hotel-costs', async (_req: Request, res: Response) => {
  try {
    const data = await getMany(`
      SELECT * FROM hotel_costs
      ORDER BY snapshot_date DESC
      LIMIT 12
    `);

    res.json(data.reverse());
  } catch (error) {
    log('error', 'Failed to get hotel costs', { error: String(error) });
    res.status(500).json({ error: 'Failed to get hotel costs' });
  }
});

// =============================================================================
// DETENTION DATA
// =============================================================================

app.get('/api/detention/facilities', async (_req: Request, res: Response) => {
  try {
    const data = await getMany(`
      SELECT 
        df.*,
        dp.population,
        dp.occupancy_pct,
        dp.snapshot_date
      FROM detention_facilities df
      LEFT JOIN detention_population dp ON df.id = dp.facility_id
        AND dp.snapshot_date = (SELECT MAX(snapshot_date) FROM detention_population)
      WHERE df.closed_date IS NULL
      ORDER BY dp.population DESC NULLS LAST
    `);

    res.json(data);
  } catch (error) {
    log('error', 'Failed to get detention facilities', { error: String(error) });
    res.status(500).json({ error: 'Failed to get detention facilities' });
  }
});

app.get('/api/detention/outcomes', async (_req: Request, res: Response) => {
  try {
    const data = await getMany(`
      SELECT * FROM detention_outcomes
      WHERE quarter_end = (SELECT MAX(quarter_end) FROM detention_outcomes)
      ORDER BY count DESC
    `);

    res.json(data);
  } catch (error) {
    log('error', 'Failed to get detention outcomes', { error: String(error) });
    res.status(500).json({ error: 'Failed to get detention outcomes' });
  }
});

// =============================================================================
// INSIGHTS
// =============================================================================

app.get('/api/insights', async (req: Request, res: Response) => {
  try {
    const { type, limit = 20 } = req.query;
    
    let whereClause = 'WHERE (expires_at IS NULL OR expires_at > CURRENT_DATE)';
    const params: any[] = [Number(limit) || 20];
    
    if (type) {
      params.push(type);
      whereClause += ` AND insight_type = $${params.length}`;
    }

    const data = await getMany<AutoInsight>(`
      SELECT * FROM auto_insights
      ${whereClause}
      ORDER BY magnitude DESC, generated_date DESC
      LIMIT $1
    `, params);

    res.json(data);
  } catch (error) {
    log('error', 'Failed to get insights', { error: String(error) });
    res.status(500).json({ error: 'Failed to get insights' });
  }
});

// =============================================================================
// SEARCH
// =============================================================================

app.get('/api/search', async (req: Request, res: Response) => {
  try {
    const { q } = req.query;
    
    if (!q || String(q).length < 2) {
      res.json({ las: [], nationalities: [] });
      return;
    }

    const searchTerm = `%${String(q).toLowerCase()}%`;

    const [las, nationalities] = await Promise.all([
      getMany(`
        SELECT id, name, ons_code, region 
        FROM local_authorities 
        WHERE LOWER(name) LIKE $1 
        ORDER BY name 
        LIMIT 10
      `, [searchTerm]),
      getMany(`
        SELECT id, name, iso3 
        FROM nationalities 
        WHERE LOWER(name) LIKE $1 
        ORDER BY name 
        LIMIT 10
      `, [searchTerm]),
    ]);

    res.json({ las, nationalities });
  } catch (error) {
    log('error', 'Search failed', { error: String(error) });
    res.status(500).json({ error: 'Search failed' });
  }
});

// =============================================================================
// ADMIN: MANUAL INGESTION TRIGGERS
// =============================================================================

app.post('/api/admin/ingest/:sourceCode', async (req: Request, res: Response) => {
  try {
    const { sourceCode } = req.params;
    const apiKey = req.headers['x-api-key'];
    
    // Simple API key check
    if (apiKey !== process.env.ADMIN_API_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    log('info', `Manual ingest triggered for ${sourceCode}`);
    const run = await runIngestor(sourceCode);
    
    res.json({
      message: `Ingestion completed for ${sourceCode}`,
      run,
    });
  } catch (error) {
    log('error', 'Manual ingest failed', { error: String(error) });
    res.status(500).json({ error: 'Ingestion failed', details: String(error) });
  }
});

app.post('/api/admin/ingest-all', async (req: Request, res: Response) => {
  try {
    const { tier } = req.body;
    const apiKey = req.headers['x-api-key'];
    
    if (apiKey !== process.env.ADMIN_API_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    log('info', `Manual ingest-all triggered`, { tier });
    const runs = await runAllIngestors(tier);
    
    res.json({
      message: `Ingestion completed for ${runs.length} sources`,
      runs,
    });
  } catch (error) {
    log('error', 'Ingest-all failed', { error: String(error) });
    res.status(500).json({ error: 'Ingestion failed', details: String(error) });
  }
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, () => {
  log('info', `UK Asylum Dashboard API running on port ${PORT}`);
});

export default app;
