// UK Asylum Dashboard - Express API Server with Auto-Migration
import express, { Request, Response } from 'express';
import cors from 'cors';
import { Pool } from 'pg';

const app = express();
const PORT = process.env.PORT || 3001;

// Database pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Helper functions
function log(level: string, message: string, meta?: any) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...meta }));
}

async function query(text: string, params?: any[]) {
  return pool.query(text, params);
}

async function getOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const res = await query(text, params);
  return res.rows[0] || null;
}

async function getMany<T = any>(text: string, params?: any[]): Promise<T[]> {
  const res = await query(text, params);
  return res.rows;
}

// Middleware
app.use(cors());
app.use(express.json());

app.use((req, _res, next) => {
  log('info', `${req.method} ${req.path}`);
  next();
});

// =============================================================================
// AUTO-MIGRATION: Create tables on startup
// =============================================================================

async function initDatabase() {
  log('info', 'Initializing database...');
  
  try {
    // Create essential tables
    await query(`
      -- Data Sources
      CREATE TABLE IF NOT EXISTS data_sources (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        url TEXT,
        frequency VARCHAR(50) DEFAULT 'quarterly',
        tier CHAR(1) DEFAULT 'B',
        parser_type VARCHAR(50) DEFAULT 'ods',
        status VARCHAR(50) DEFAULT 'active',
        last_checked TIMESTAMPTZ,
        last_updated TIMESTAMPTZ,
        content_hash VARCHAR(64),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Ingest Runs
      CREATE TABLE IF NOT EXISTS ingest_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id INTEGER REFERENCES data_sources(id),
        status VARCHAR(50) DEFAULT 'pending',
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        records_processed INTEGER DEFAULT 0,
        records_inserted INTEGER DEFAULT 0,
        records_updated INTEGER DEFAULT 0,
        error_message TEXT,
        content_hash VARCHAR(64),
        metadata JSONB DEFAULT '{}'
      );

      -- Local Authorities
      CREATE TABLE IF NOT EXISTS local_authorities (
        id SERIAL PRIMARY KEY,
        ons_code VARCHAR(20) UNIQUE,
        name VARCHAR(255) NOT NULL,
        name_normalized VARCHAR(255),
        region VARCHAR(100),
        country VARCHAR(50) DEFAULT 'England',
        population INTEGER,
        population_year INTEGER,
        imd_rank INTEGER,
        imd_score NUMERIC(10,2),
        geojson JSONB,
        centroid_lat NUMERIC(10,6),
        centroid_lng NUMERIC(10,6),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Nationalities
      CREATE TABLE IF NOT EXISTS nationalities (
        id SERIAL PRIMARY KEY,
        iso3 CHAR(3) UNIQUE,
        iso2 CHAR(2),
        name VARCHAR(255) NOT NULL UNIQUE,
        name_normalized VARCHAR(255),
        region VARCHAR(100),
        is_safe_country BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Detention Facilities
      CREATE TABLE IF NOT EXISTS detention_facilities (
        id SERIAL PRIMARY KEY,
        code VARCHAR(20) UNIQUE,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(100),
        operator VARCHAR(255),
        capacity INTEGER,
        la_id INTEGER REFERENCES local_authorities(id),
        lat NUMERIC(10,6),
        lng NUMERIC(10,6),
        opened_date DATE,
        closed_date DATE,
        hmip_rating VARCHAR(50),
        hmip_last_inspection DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Small Boat Arrivals Daily
      CREATE TABLE IF NOT EXISTS small_boat_arrivals_daily (
        id SERIAL PRIMARY KEY,
        date DATE UNIQUE NOT NULL,
        arrivals INTEGER NOT NULL,
        boats INTEGER,
        people_per_boat NUMERIC(5,1),
        source_url TEXT,
        scraped_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Small Boat Arrivals Weekly
      CREATE TABLE IF NOT EXISTS small_boat_arrivals_weekly (
        id SERIAL PRIMARY KEY,
        week_ending DATE NOT NULL,
        year INTEGER NOT NULL,
        week_number INTEGER,
        arrivals INTEGER NOT NULL,
        boats INTEGER,
        ytd_arrivals INTEGER,
        ytd_boats INTEGER,
        ingest_run_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(week_ending, year)
      );

      -- Small Boat Nationality
      CREATE TABLE IF NOT EXISTS small_boat_nationality (
        id SERIAL PRIMARY KEY,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        period_type VARCHAR(20) DEFAULT 'year',
        nationality_id INTEGER REFERENCES nationalities(id),
        nationality_name VARCHAR(255),
        arrivals INTEGER NOT NULL,
        share_pct NUMERIC(5,2),
        ingest_run_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Asylum Claims
      CREATE TABLE IF NOT EXISTS asylum_claims (
        id SERIAL PRIMARY KEY,
        quarter_end DATE NOT NULL,
        year INTEGER NOT NULL,
        quarter INTEGER NOT NULL,
        nationality_id INTEGER REFERENCES nationalities(id),
        nationality_name VARCHAR(255),
        claims_main_applicant INTEGER,
        claims_dependants INTEGER,
        claims_total INTEGER,
        claims_in_country INTEGER,
        claims_at_port INTEGER,
        ingest_run_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Asylum Decisions
      CREATE TABLE IF NOT EXISTS asylum_decisions (
        id SERIAL PRIMARY KEY,
        quarter_end DATE NOT NULL,
        year INTEGER NOT NULL,
        quarter INTEGER NOT NULL,
        nationality_id INTEGER REFERENCES nationalities(id),
        nationality_name VARCHAR(255),
        decisions_total INTEGER,
        granted_asylum INTEGER,
        granted_hp INTEGER,
        granted_dl INTEGER,
        granted_uasc_leave INTEGER,
        grants_total INTEGER,
        refused INTEGER,
        withdrawn INTEGER,
        grant_rate_pct NUMERIC(5,2),
        ingest_run_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Asylum Backlog
      CREATE TABLE IF NOT EXISTS asylum_backlog (
        id SERIAL PRIMARY KEY,
        snapshot_date DATE UNIQUE NOT NULL,
        total_awaiting INTEGER NOT NULL,
        awaiting_initial INTEGER,
        awaiting_further_review INTEGER,
        awaiting_less_6_months INTEGER,
        awaiting_6_12_months INTEGER,
        awaiting_1_3_years INTEGER,
        awaiting_3_plus_years INTEGER,
        legacy_cases INTEGER,
        ingest_run_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Asylum Support LA (KEY TABLE)
      CREATE TABLE IF NOT EXISTS asylum_support_la (
        id SERIAL PRIMARY KEY,
        snapshot_date DATE NOT NULL,
        la_id INTEGER REFERENCES local_authorities(id),
        la_name VARCHAR(255),
        region VARCHAR(100),
        total_supported INTEGER NOT NULL,
        section_95 INTEGER,
        section_4 INTEGER,
        section_98 INTEGER,
        dispersed INTEGER,
        initial_accommodation INTEGER,
        hotel INTEGER,
        subsistence_only INTEGER,
        main_applicants INTEGER,
        dependants INTEGER,
        per_10k_population NUMERIC(10,2),
        national_share_pct NUMERIC(5,2),
        hotel_share_pct NUMERIC(5,2),
        qoq_change_pct NUMERIC(10,2),
        yoy_change_pct NUMERIC(10,2),
        ingest_run_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Spending Annual
      CREATE TABLE IF NOT EXISTS spending_annual (
        id SERIAL PRIMARY KEY,
        financial_year VARCHAR(10) UNIQUE NOT NULL,
        fy_start DATE,
        fy_end DATE,
        total_spend_millions NUMERIC(12,2),
        accommodation_spend NUMERIC(12,2),
        hotel_spend NUMERIC(12,2),
        dispersed_spend NUMERIC(12,2),
        initial_accommodation_spend NUMERIC(12,2),
        detention_removals_spend NUMERIC(12,2),
        appeals_tribunal_spend NUMERIC(12,2),
        legal_aid_spend NUMERIC(12,2),
        uasc_grants_spend NUMERIC(12,2),
        other_spend NUMERIC(12,2),
        avg_supported_population INTEGER,
        cost_per_person NUMERIC(12,2),
        cost_per_decision NUMERIC(12,2),
        source VARCHAR(255),
        ingest_run_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Hotel Costs
      CREATE TABLE IF NOT EXISTS hotel_costs (
        id SERIAL PRIMARY KEY,
        snapshot_date DATE NOT NULL,
        hotel_population INTEGER,
        cost_per_night NUMERIC(10,2),
        dispersed_cost_per_night NUMERIC(10,2),
        premium_multiple NUMERIC(5,2),
        annual_hotel_cost_millions NUMERIC(12,2),
        potential_saving_millions NUMERIC(12,2),
        source VARCHAR(255),
        ingest_run_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Detention Population
      CREATE TABLE IF NOT EXISTS detention_population (
        id SERIAL PRIMARY KEY,
        snapshot_date DATE NOT NULL,
        facility_id INTEGER REFERENCES detention_facilities(id),
        facility_name VARCHAR(255),
        population INTEGER NOT NULL,
        capacity INTEGER,
        occupancy_pct NUMERIC(5,2),
        ingest_run_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Detention Outcomes
      CREATE TABLE IF NOT EXISTS detention_outcomes (
        id SERIAL PRIMARY KEY,
        quarter_end DATE NOT NULL,
        outcome VARCHAR(100) NOT NULL,
        count INTEGER,
        share_pct NUMERIC(5,2),
        ingest_run_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Auto Insights
      CREATE TABLE IF NOT EXISTS auto_insights (
        id SERIAL PRIMARY KEY,
        generated_date DATE DEFAULT CURRENT_DATE,
        insight_type VARCHAR(50) NOT NULL,
        subject VARCHAR(255),
        metric VARCHAR(100),
        headline TEXT NOT NULL,
        detail TEXT,
        magnitude NUMERIC(12,2),
        expires_at DATE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_asylum_support_la_date ON asylum_support_la(snapshot_date DESC);
      CREATE INDEX IF NOT EXISTS idx_asylum_support_la_la_id ON asylum_support_la(la_id);
      CREATE INDEX IF NOT EXISTS idx_small_boat_daily_date ON small_boat_arrivals_daily(date DESC);
      CREATE INDEX IF NOT EXISTS idx_asylum_claims_quarter ON asylum_claims(quarter_end DESC);
      CREATE INDEX IF NOT EXISTS idx_asylum_decisions_quarter ON asylum_decisions(quarter_end DESC);
    `);

    log('info', 'Database tables created');

    // Seed essential reference data
    await seedReferenceData();
    
    log('info', 'Database initialization complete');
  } catch (error) {
    log('error', 'Database initialization failed', { error: String(error) });
    throw error;
  }
}

async function seedReferenceData() {
  // Check if already seeded
  const existing = await getOne('SELECT COUNT(*) as count FROM local_authorities');
  if (existing && parseInt(existing.count) > 0) {
    log('info', 'Reference data already exists, skipping seed');
    return;
  }

  log('info', 'Seeding reference data...');

  // Seed data sources
  const sources = [
    { code: 'SBA_DAILY', name: 'Small Boat Arrivals Daily', tier: 'A' },
    { code: 'SBA_WEEKLY', name: 'Small Boat Time Series Weekly', tier: 'A' },
    { code: 'ASY_D01', name: 'Asylum Claims by Nationality', tier: 'B' },
    { code: 'ASY_D02', name: 'Asylum Decisions by Nationality', tier: 'B' },
    { code: 'ASY_D03', name: 'Asylum Backlog', tier: 'B' },
    { code: 'ASY_D11', name: 'Asylum Support by LA', tier: 'B' },
  ];

  for (const s of sources) {
    await query(
      `INSERT INTO data_sources (code, name, tier) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`,
      [s.code, s.name, s.tier]
    );
  }

  // Seed local authorities
  const las = [
    { ons_code: 'E08000025', name: 'Birmingham', region: 'West Midlands', population: 1157603 },
    { ons_code: 'S12000049', name: 'Glasgow City', region: 'Scotland', population: 635640 },
    { ons_code: 'E09000017', name: 'Hillingdon', region: 'London', population: 309014 },
    { ons_code: 'E08000003', name: 'Manchester', region: 'North West', population: 568996 },
    { ons_code: 'E08000012', name: 'Liverpool', region: 'North West', population: 496784 },
    { ons_code: 'E08000035', name: 'Leeds', region: 'Yorkshire and The Humber', population: 812000 },
    { ons_code: 'E08000021', name: 'Newcastle upon Tyne', region: 'North East', population: 307220 },
    { ons_code: 'E06000018', name: 'Nottingham', region: 'East Midlands', population: 338590 },
    { ons_code: 'E08000019', name: 'Sheffield', region: 'Yorkshire and The Humber', population: 589860 },
    { ons_code: 'E08000032', name: 'Bradford', region: 'Yorkshire and The Humber', population: 546400 },
    { ons_code: 'E06000023', name: 'Bristol', region: 'South West', population: 472400 },
    { ons_code: 'E08000026', name: 'Coventry', region: 'West Midlands', population: 379387 },
    { ons_code: 'W06000015', name: 'Cardiff', region: 'Wales', population: 369202 },
    { ons_code: 'E09000008', name: 'Croydon', region: 'London', population: 396100 },
    { ons_code: 'E09000025', name: 'Newham', region: 'London', population: 387900 },
  ];

  for (const la of las) {
    await query(
      `INSERT INTO local_authorities (ons_code, name, name_normalized, region, population, population_year) 
       VALUES ($1, $2, $3, $4, $5, 2023) ON CONFLICT (ons_code) DO NOTHING`,
      [la.ons_code, la.name, la.name.toLowerCase(), la.region, la.population]
    );
  }

  // Seed nationalities
  const nationalities = [
    { iso3: 'AFG', name: 'Afghan' },
    { iso3: 'ALB', name: 'Albanian' },
    { iso3: 'ERI', name: 'Eritrean' },
    { iso3: 'IRN', name: 'Iranian' },
    { iso3: 'IRQ', name: 'Iraqi' },
    { iso3: 'SYR', name: 'Syrian' },
    { iso3: 'SDN', name: 'Sudanese' },
    { iso3: 'VNM', name: 'Vietnamese' },
    { iso3: 'PAK', name: 'Pakistani' },
    { iso3: 'IND', name: 'Indian' },
  ];

  for (const nat of nationalities) {
    await query(
      `INSERT INTO nationalities (iso3, name, name_normalized) VALUES ($1, $2, $3) ON CONFLICT (iso3) DO NOTHING`,
      [nat.iso3, nat.name, nat.name.toLowerCase()]
    );
  }

  // Seed sample spending data
  const spending = [
    { fy: '2021-22', total: 1530, hotel: 500 },
    { fy: '2022-23', total: 3068, hotel: 1200 },
    { fy: '2023-24', total: 4319, hotel: 1800 },
    { fy: '2024-25', total: 4700, hotel: 2100 },
  ];

  for (const s of spending) {
    await query(
      `INSERT INTO spending_annual (financial_year, total_spend_millions, hotel_spend) 
       VALUES ($1, $2, $3) ON CONFLICT (financial_year) DO NOTHING`,
      [s.fy, s.total, s.hotel]
    );
  }

  // Seed sample backlog data
  await query(`
    INSERT INTO asylum_backlog (snapshot_date, total_awaiting, awaiting_less_6_months, awaiting_6_12_months, awaiting_1_3_years, awaiting_3_plus_years)
    VALUES 
      ('2024-06-30', 118000, 25000, 30000, 45000, 18000),
      ('2024-09-30', 105000, 22000, 28000, 40000, 15000),
      ('2024-12-31', 92000, 20000, 25000, 35000, 12000),
      ('2025-03-31', 85000, 18000, 22000, 32000, 13000)
    ON CONFLICT (snapshot_date) DO NOTHING
  `);

  // Seed sample LA support data
  const sampleSupport = [
    { la_name: 'Glasgow City', total: 3844, hotel: 1200, dispersed: 2100 },
    { la_name: 'Birmingham', total: 2755, hotel: 900, dispersed: 1500 },
    { la_name: 'Hillingdon', total: 2481, hotel: 2100, dispersed: 200 },
    { la_name: 'Manchester', total: 2100, hotel: 600, dispersed: 1200 },
    { la_name: 'Liverpool', total: 1850, hotel: 400, dispersed: 1200 },
    { la_name: 'Leeds', total: 1720, hotel: 300, dispersed: 1100 },
    { la_name: 'Sheffield', total: 1450, hotel: 250, dispersed: 900 },
    { la_name: 'Newcastle upon Tyne', total: 1320, hotel: 200, dispersed: 850 },
    { la_name: 'Bristol', total: 1180, hotel: 350, dispersed: 650 },
    { la_name: 'Coventry', total: 1050, hotel: 280, dispersed: 600 },
    { la_name: 'Bradford', total: 980, hotel: 150, dispersed: 700 },
    { la_name: 'Cardiff', total: 920, hotel: 200, dispersed: 580 },
    { la_name: 'Nottingham', total: 870, hotel: 180, dispersed: 550 },
    { la_name: 'Croydon', total: 1650, hotel: 900, dispersed: 500 },
    { la_name: 'Newham', total: 1420, hotel: 850, dispersed: 400 },
  ];

  for (const s of sampleSupport) {
    const la = await getOne('SELECT id, population FROM local_authorities WHERE name = $1', [s.la_name]);
    if (la) {
      const per10k = la.population ? Math.round((s.total / la.population) * 100000) / 10 : null;
      const hotelShare = s.total > 0 ? Math.round((s.hotel / s.total) * 1000) / 10 : 0;
      
      await query(
        `INSERT INTO asylum_support_la (snapshot_date, la_id, la_name, total_supported, hotel, dispersed, per_10k_population, hotel_share_pct)
         VALUES (CURRENT_DATE - INTERVAL '7 days', $1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [la.id, s.la_name, s.total, s.hotel, s.dispersed, per10k, hotelShare]
      );
    }
  }

  log('info', 'Reference data seeded');
}

// =============================================================================
// HEALTH & STATUS
// =============================================================================

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/status', async (_req: Request, res: Response) => {
  try {
    const [sources, lastRun, dbSize] = await Promise.all([
      getMany('SELECT code, name, last_updated, status FROM data_sources ORDER BY last_updated DESC NULLS LAST LIMIT 10'),
      getOne('SELECT * FROM ingest_runs ORDER BY started_at DESC LIMIT 1'),
      getOne("SELECT pg_size_pretty(pg_database_size(current_database())) as size"),
    ]);
    
    res.json({ database_size: dbSize?.size, sources, last_ingest: lastRun });
  } catch (error) {
    log('error', 'Status error', { error: String(error) });
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// =============================================================================
// DASHBOARD SUMMARY
// =============================================================================

app.get('/api/dashboard/summary', async (_req: Request, res: Response) => {
  try {
    const supportTotal = await getOne<{ total: number; hotel: number; snapshot_date: Date }>(`
      SELECT SUM(total_supported) as total, SUM(hotel) as hotel, MAX(snapshot_date) as snapshot_date
      FROM asylum_support_la
      WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM asylum_support_la)
    `);

    const spending = await getOne(`SELECT * FROM spending_annual ORDER BY financial_year DESC LIMIT 1`);
    const backlog = await getOne(`SELECT total_awaiting FROM asylum_backlog ORDER BY snapshot_date DESC LIMIT 1`);
    const ytdArrivals = await getOne(`SELECT ytd_arrivals as ytd FROM small_boat_arrivals_weekly ORDER BY week_ending DESC LIMIT 1`);

    const summary = {
      total_supported: supportTotal?.total || 0,
      total_spend_millions: spending?.total_spend_millions || 0,
      backlog_total: backlog?.total_awaiting || 0,
      hotel_population: supportTotal?.hotel || 0,
      hotel_share_pct: supportTotal?.total && supportTotal?.hotel 
        ? Math.round((supportTotal.hotel / supportTotal.total) * 1000) / 10 
        : 0,
      ytd_small_boat_arrivals: ytdArrivals?.ytd || 0,
      last_updated: supportTotal?.snapshot_date || new Date(),
    };

    res.json(summary);
  } catch (error) {
    log('error', 'Dashboard summary error', { error: String(error) });
    res.status(500).json({ error: 'Failed to get dashboard summary' });
  }
});

// =============================================================================
// LOCAL AUTHORITY DATA
// =============================================================================

app.get('/api/la', async (req: Request, res: Response) => {
  try {
    const { region, sort = 'total_supported', order = 'desc', limit = 100 } = req.query;
    
    let whereClause = 'WHERE asl.snapshot_date = (SELECT MAX(snapshot_date) FROM asylum_support_la)';
    const params: any[] = [];
    
    if (region) {
      params.push(region);
      whereClause += ` AND asl.region = $${params.length}`;
    }

    const sortColumn = ['total_supported', 'per_10k_population', 'hotel_share_pct', 'la_name']
      .includes(String(sort)) ? sort : 'total_supported';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

    params.push(Number(limit) || 100);

    const data = await getMany(`
      SELECT asl.*, la.ons_code, la.population, la.centroid_lat, la.centroid_lng
      FROM asylum_support_la asl
      LEFT JOIN local_authorities la ON asl.la_id = la.id
      ${whereClause}
      ORDER BY ${sortColumn} ${sortOrder} NULLS LAST
      LIMIT $${params.length}
    `, params);

    res.json(data);
  } catch (error) {
    log('error', 'LA data error', { error: String(error) });
    res.status(500).json({ error: 'Failed to get LA data' });
  }
});

app.get('/api/la/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const la = await getOne('SELECT * FROM local_authorities WHERE id = $1 OR ons_code = $1', [id]);
    if (!la) {
      res.status(404).json({ error: 'Local authority not found' });
      return;
    }

    const currentSupport = await getOne(`
      SELECT * FROM asylum_support_la WHERE la_id = $1 ORDER BY snapshot_date DESC LIMIT 1
    `, [la.id]);

    const historicalSupport = await getMany(`
      SELECT * FROM asylum_support_la WHERE la_id = $1 ORDER BY snapshot_date DESC LIMIT 8
    `, [la.id]);

    res.json({ la, current_support: currentSupport, historical_support: historicalSupport });
  } catch (error) {
    log('error', 'LA detail error', { error: String(error) });
    res.status(500).json({ error: 'Failed to get LA detail' });
  }
});

app.get('/api/regions', async (_req: Request, res: Response) => {
  try {
    const data = await getMany(`
      SELECT region, SUM(total_supported) as total_supported, SUM(hotel) as hotel_population,
             COUNT(*) as la_count, ROUND(AVG(per_10k_population)::numeric, 2) as avg_per_10k
      FROM asylum_support_la
      WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM asylum_support_la)
        AND region IS NOT NULL AND region != ''
      GROUP BY region
      ORDER BY total_supported DESC
    `);
    res.json(data);
  } catch (error) {
    log('error', 'Regions error', { error: String(error) });
    res.status(500).json({ error: 'Failed to get regions' });
  }
});

// =============================================================================
// SMALL BOAT ARRIVALS
// =============================================================================

app.get('/api/small-boats/daily', async (req: Request, res: Response) => {
  try {
    const { days = 30 } = req.query;
    const data = await getMany(`SELECT * FROM small_boat_arrivals_daily ORDER BY date DESC LIMIT $1`, [Number(days) || 30]);
    res.json(data.reverse());
  } catch (error) {
    log('error', 'Daily arrivals error', { error: String(error) });
    res.status(500).json({ error: 'Failed to get daily arrivals' });
  }
});

app.get('/api/small-boats/weekly', async (req: Request, res: Response) => {
  try {
    const { year } = req.query;
    let sql = 'SELECT * FROM small_boat_arrivals_weekly';
    const params: any[] = [];
    
    if (year) {
      params.push(Number(year));
      sql += ' WHERE year = $1';
    }
    sql += ' ORDER BY week_ending DESC';
    
    const data = await getMany(sql, params);
    res.json(data.reverse());
  } catch (error) {
    log('error', 'Weekly arrivals error', { error: String(error) });
    res.status(500).json({ error: 'Failed to get weekly arrivals' });
  }
});

// =============================================================================
// ASYLUM DATA
// =============================================================================

app.get('/api/grant-rates', async (req: Request, res: Response) => {
  try {
    const { min_decisions = 50 } = req.query;
    const data = await getMany(`
      SELECT * FROM asylum_decisions
      WHERE decisions_total >= $1
        AND quarter_end = (SELECT MAX(quarter_end) FROM asylum_decisions)
      ORDER BY grant_rate_pct DESC
    `, [Number(min_decisions) || 50]);
    res.json(data);
  } catch (error) {
    log('error', 'Grant rates error', { error: String(error) });
    res.status(500).json({ error: 'Failed to get grant rates' });
  }
});

app.get('/api/backlog/timeseries', async (_req: Request, res: Response) => {
  try {
    const data = await getMany(`
      SELECT snapshot_date as date, total_awaiting as value, 'Backlog' as label
      FROM asylum_backlog ORDER BY snapshot_date
    `);
    res.json(data);
  } catch (error) {
    log('error', 'Backlog timeseries error', { error: String(error) });
    res.status(500).json({ error: 'Failed to get backlog timeseries' });
  }
});

// =============================================================================
// SPENDING DATA
// =============================================================================

app.get('/api/spending', async (_req: Request, res: Response) => {
  try {
    const data = await getMany(`SELECT * FROM spending_annual ORDER BY financial_year`);
    res.json(data);
  } catch (error) {
    log('error', 'Spending error', { error: String(error) });
    res.status(500).json({ error: 'Failed to get spending data' });
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
      getMany(`SELECT id, name, ons_code, region FROM local_authorities WHERE LOWER(name) LIKE $1 ORDER BY name LIMIT 10`, [searchTerm]),
      getMany(`SELECT id, name, iso3 FROM nationalities WHERE LOWER(name) LIKE $1 ORDER BY name LIMIT 10`, [searchTerm]),
    ]);

    res.json({ las, nationalities });
  } catch (error) {
    log('error', 'Search error', { error: String(error) });
    res.status(500).json({ error: 'Search failed' });
  }
});

// =============================================================================
// 404 HANDLER
// =============================================================================

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// =============================================================================
// START SERVER
// =============================================================================

async function start() {
  try {
    await initDatabase();
    
    app.listen(PORT, () => {
      log('info', `UK Asylum Dashboard API running on port ${PORT}`);
    });
  } catch (error) {
    log('error', 'Failed to start server', { error: String(error) });
    process.exit(1);
  }
}

start();

export default app;
