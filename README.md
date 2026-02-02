# UK Asylum Dashboard - Backend

Comprehensive backend API for the UK Asylum Dashboard, ingesting data from **89 official government sources**.

## Overview

This backend provides:
- **Automated data ingestion** from Home Office, NAO, ONS, and HMCTS sources
- **REST API** for dashboard consumption
- **PostgreSQL database** with optimized schema for asylum/immigration analytics
- **Scheduled jobs** for daily, weekly, and quarterly data updates
- **Auto-generated insights** from data analysis

## Data Sources

### Tier A: Live/Weekly (3 sources)
| Code | Description | Frequency |
|------|-------------|-----------|
| `SBA_DAILY` | Small Boat Arrivals | Daily HTML scrape |
| `SBA_WEEKLY` | Small Boat Time Series | Weekly ODS |
| `FRENCH_PREV` | French Prevention Activity | Weekly ODS |

### Tier B: Quarterly (25+ sources)
- **Asylum**: Claims (Asy_D01), Decisions (Asy_D02), Backlog (Asy_D03), Age Disputes (Asy_D06), UASC (Asy_D07)
- **Support**: Regional (Asy_D09), LA-level (Asy_D11) - **key geographic data**
- **Appeals**: HMCTS First-tier Immigration & Asylum Tribunal
- **Detention**: Population, facilities, length, outcomes, Rule 35 reports
- **Returns**: Enforced, voluntary, assisted voluntary returns
- **NRM**: Modern slavery referrals and decisions
- **Resettlement**: ACRS, ARAP, UKRS, Homes for Ukraine

### Tier C: Annual (5+ sources)
- NAO Asylum Spending Analysis
- Home Office Annual Accounts
- ONS Population Estimates
- LA Boundaries GeoJSON
- Index of Multiple Deprivation

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- npm or yarn

### Installation

```bash
# Clone and install
cd uk-asylum-backend
npm install

# Set up environment
cp .env.example .env
# Edit .env with your database URL

# Create database schema
npm run db:migrate

# Seed reference data
npm run db:seed

# Start development server
npm run dev
```

### Running Ingestion

```bash
# Single source
npm run ingest SBA_DAILY

# All Tier A (daily/weekly) sources
npm run ingest:daily

# All Tier B (quarterly) sources
npm run ingest:quarterly

# Generate insights
npm run insights:generate
```

## API Endpoints

### Dashboard
```
GET /api/dashboard/summary
  Returns: total_supported, total_spend, backlog, hotel_population, etc.

GET /api/insights
  Returns: Auto-generated analytical insights
```

### Local Authority Data
```
GET /api/la
  Query: region, sort, order, limit
  Returns: All LAs with latest support data

GET /api/la/:id
  Returns: LA detail with historical support data

GET /api/la/geojson
  Returns: GeoJSON FeatureCollection for map visualization

GET /api/regions
  Returns: Regional summary statistics
```

### Small Boat Arrivals
```
GET /api/small-boats/daily?days=30
  Returns: Daily arrivals for last N days

GET /api/small-boats/weekly?year=2025
  Returns: Weekly time series

GET /api/small-boats/nationality?year=2025
  Returns: Arrivals breakdown by nationality
```

### Asylum Data
```
GET /api/grant-rates?min_decisions=50
  Returns: Grant rates by nationality

GET /api/claims/timeseries?nationality=Syrian
  Returns: Claims time series

GET /api/backlog/timeseries
  Returns: Backlog history
```

### Spending
```
GET /api/spending
  Returns: Annual spending breakdown

GET /api/spending/hotel-costs
  Returns: Hotel vs dispersed cost comparison
```

### Detention
```
GET /api/detention/facilities
  Returns: All IRCs with current population

GET /api/detention/outcomes
  Returns: Detention outcome breakdown
```

### Search
```
GET /api/search?q=birmingham
  Returns: Matching LAs and nationalities
```

## Database Schema

Key tables:
- `local_authorities` - LA reference with boundaries
- `nationalities` - Country reference
- `asylum_support_la` - **Core LA-level support data**
- `asylum_claims` / `asylum_decisions` - Claims and outcomes
- `asylum_backlog` - Backlog snapshots
- `small_boat_arrivals_*` - Daily and weekly crossings
- `detention_*` - IRC population and outcomes
- `spending_annual` - Cost data
- `auto_insights` - Generated insights

See `sql/schema.sql` for full schema.

## Scheduling

The scheduler runs as a separate process:

```bash
npm run scheduler
```

Schedule configuration in `src/lib/ingest.ts`:

| Source | Schedule | Notes |
|--------|----------|-------|
| SBA_DAILY | Every 3 hours 7am-10pm | HTML scrape |
| SBA_WEEKLY | Fridays noon | ODS release |
| Quarterly sources | Daily 9am | Checks for updates |
| ONS_POP | Mondays 9am | Annual data |

## Environment Variables

```env
DATABASE_URL=postgresql://user:pass@host:5432/dbname
PORT=3001
ADMIN_API_KEY=your-secret-key
LOG_QUERIES=false
RUN_INITIAL_INGEST=false
NODE_ENV=production
```

## Ethical Boundaries

This system **does NOT** collect or expose:
- ❌ Accommodation addresses (operational security risk)
- ❌ Individual movement data (illegal under GDPR)
- ❌ Live enforcement operations
- ❌ Social media scraping
- ❌ Per-hotel cost estimates (speculation)

All data comes from official government publications only.

## Architecture

```
src/
├── api/           # Express route handlers
├── ingestion/     # Data source parsers
│   ├── small-boats-daily.ts
│   ├── small-boats-weekly.ts
│   ├── asylum-support-la.ts
│   ├── asylum-claims.ts
│   └── ...
├── lib/
│   ├── db.ts      # Database utilities
│   └── ingest.ts  # Ingestion framework
├── types/         # TypeScript definitions
├── server.ts      # Express app
└── scheduler.ts   # Cron jobs

scripts/
├── seed.ts              # Reference data seeder
├── run-ingest.ts        # Manual ingestion runner
└── generate-insights.ts # Analytics generator

sql/
└── schema.sql     # Full PostgreSQL schema
```

## Frontend Integration

This backend is designed for use with a Lovable/React frontend. Key integration points:

1. **Dashboard Summary**: `/api/dashboard/summary` for hero stats
2. **LA Map**: `/api/la/geojson` returns GeoJSON with support data properties
3. **LA Table**: `/api/la` with sorting/filtering
4. **Time Series**: Various `/timeseries` endpoints for charts
5. **Real-time**: Poll `SBA_DAILY` for latest crossing numbers

Example fetch:
```typescript
const response = await fetch('http://localhost:3001/api/la?sort=per_10k_population&order=desc&limit=50');
const data = await response.json();
```

## Development

```bash
# Type checking
npm run typecheck

# Linting
npm run lint

# Build for production
npm run build
npm start
```

## Deployment

Recommended: Railway, Render, or Fly.io

```bash
# Railway
railway init
railway add --database postgresql
railway up

# Set environment variables in dashboard
```

## Data Refresh Schedule

| Data | Frequency | Lag |
|------|-----------|-----|
| Small boat arrivals | Daily | Same day |
| Small boat series | Weekly | Fridays |
| Visa applications | Monthly | ~2 weeks |
| Ukraine arrivals | Weekly | ~1 week |
| Quarterly asylum data | Quarterly | 6-8 weeks |
| Spending | Annual | After accounts published |

## License

MIT

## Acknowledgments

Data sources:
- UK Home Office Immigration Statistics
- National Audit Office
- HM Courts & Tribunals Service
- Office for National Statistics
- GOV.UK Statistical Data Service
