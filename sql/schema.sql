-- UK Asylum Dashboard - Comprehensive Database Schema
-- 89 Official Data Sources
-- Created: 2026-02-02

-- =============================================================================
-- EXTENSIONS
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- For text search

-- =============================================================================
-- ENUMS
-- =============================================================================
CREATE TYPE data_source_status AS ENUM ('active', 'deprecated', 'error');
CREATE TYPE ingest_status AS ENUM ('pending', 'running', 'completed', 'failed');
CREATE TYPE update_frequency AS ENUM ('daily', 'weekly', 'monthly', 'quarterly', 'annually', 'static');
CREATE TYPE support_type AS ENUM ('section_95', 'section_4', 'section_98');
CREATE TYPE accommodation_type AS ENUM ('dispersed', 'initial', 'hotel', 'subsistence_only', 'other');
CREATE TYPE asylum_decision AS ENUM ('granted', 'refused', 'withdrawn', 'other');
CREATE TYPE appeal_outcome AS ENUM ('allowed', 'dismissed', 'withdrawn', 'other');
CREATE TYPE detention_outcome AS ENUM ('released', 'removed', 'bailed', 'granted_leave', 'other');
CREATE TYPE return_type AS ENUM ('enforced', 'voluntary', 'assisted_voluntary');
CREATE TYPE entry_method AS ENUM ('small_boat', 'lorry', 'air', 'other');
CREATE TYPE exploitation_type AS ENUM ('sexual', 'labour', 'criminal', 'domestic_servitude', 'other');
CREATE TYPE nrm_outcome AS ENUM ('positive_conclusive', 'negative_conclusive', 'positive_reasonable', 'pending');

-- =============================================================================
-- REFERENCE TABLES
-- =============================================================================

-- Data source registry
CREATE TABLE data_sources (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    url TEXT,
    file_pattern VARCHAR(255),  -- e.g., 'asylum-summary-sep-2024.ods'
    frequency update_frequency NOT NULL,
    tier VARCHAR(10) CHECK (tier IN ('A', 'B', 'C')),  -- A=live/weekly, B=quarterly, C=annual
    parser_type VARCHAR(50),  -- 'ods', 'html', 'csv', 'api'
    status data_source_status DEFAULT 'active',
    last_checked TIMESTAMPTZ,
    last_updated TIMESTAMPTZ,
    content_hash VARCHAR(64),  -- SHA256 of last fetched content
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ingestion run log
CREATE TABLE ingest_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id INTEGER REFERENCES data_sources(id),
    status ingest_status DEFAULT 'pending',
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    records_processed INTEGER DEFAULT 0,
    records_inserted INTEGER DEFAULT 0,
    records_updated INTEGER DEFAULT 0,
    error_message TEXT,
    content_hash VARCHAR(64),
    metadata JSONB DEFAULT '{}'
);

-- Local authorities reference
CREATE TABLE local_authorities (
    id SERIAL PRIMARY KEY,
    ons_code VARCHAR(10) UNIQUE NOT NULL,  -- E09000001 etc
    name VARCHAR(255) NOT NULL,
    name_normalized VARCHAR(255),  -- lowercase, no punctuation
    region VARCHAR(100),
    country VARCHAR(50),  -- England, Scotland, Wales, NI
    population INTEGER,  -- Latest ONS mid-year estimate
    population_year INTEGER,
    imd_rank INTEGER,  -- Index of Multiple Deprivation rank
    imd_score DECIMAL(10,4),
    geojson JSONB,  -- Boundary polygon
    centroid_lat DECIMAL(10,6),
    centroid_lng DECIMAL(10,6),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_la_name ON local_authorities USING gin(name gin_trgm_ops);
CREATE INDEX idx_la_region ON local_authorities(region);

-- Nationalities reference
CREATE TABLE nationalities (
    id SERIAL PRIMARY KEY,
    iso3 VARCHAR(3) UNIQUE,  -- ISO 3166-1 alpha-3
    iso2 VARCHAR(2),
    name VARCHAR(255) NOT NULL,
    name_normalized VARCHAR(255),
    region VARCHAR(100),  -- Middle East, Sub-Saharan Africa, etc.
    is_safe_country BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Detention facilities reference
CREATE TABLE detention_facilities (
    id SERIAL PRIMARY KEY,
    code VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50),  -- IRC, STHF, prison
    operator VARCHAR(255),
    capacity INTEGER,
    la_id INTEGER REFERENCES local_authorities(id),
    lat DECIMAL(10,6),
    lng DECIMAL(10,6),
    opened_date DATE,
    closed_date DATE,
    hmip_rating VARCHAR(50),
    hmip_last_inspection DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- TIER A: LIVE/WEEKLY DATA (3 sources)
-- =============================================================================

-- Small boat arrivals - daily scrape
CREATE TABLE small_boat_arrivals_daily (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    arrivals INTEGER NOT NULL,
    boats INTEGER,
    people_per_boat DECIMAL(5,1),
    source_url TEXT,
    scraped_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(date)
);

CREATE INDEX idx_sba_daily_date ON small_boat_arrivals_daily(date DESC);

-- Small boat arrivals - weekly ODS (Irr_D01)
CREATE TABLE small_boat_arrivals_weekly (
    id SERIAL PRIMARY KEY,
    week_ending DATE NOT NULL,
    year INTEGER NOT NULL,
    week_number INTEGER,
    arrivals INTEGER NOT NULL,
    boats INTEGER,
    ytd_arrivals INTEGER,
    ytd_boats INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(week_ending)
);

CREATE INDEX idx_sba_weekly_date ON small_boat_arrivals_weekly(week_ending DESC);

-- Small boat arrivals by nationality (Irr_D02)
CREATE TABLE small_boat_nationality (
    id SERIAL PRIMARY KEY,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    period_type VARCHAR(20),  -- 'year', 'quarter', 'month'
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),  -- denormalized for convenience
    arrivals INTEGER NOT NULL,
    share_pct DECIMAL(5,2),
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sbn_period ON small_boat_nationality(period_end DESC);
CREATE INDEX idx_sbn_nationality ON small_boat_nationality(nationality_id);

-- French prevention activity (weekly ODS)
CREATE TABLE french_prevention (
    id SERIAL PRIMARY KEY,
    week_ending DATE NOT NULL,
    year INTEGER,
    attempts_prevented INTEGER,
    boats_prevented INTEGER,
    people_prevented INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(week_ending)
);

-- =============================================================================
-- TIER B: QUARTERLY ASYLUM DATA (10+ sources)
-- =============================================================================

-- Asylum claims by nationality (Asy_D01)
CREATE TABLE asylum_claims (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,  -- e.g., 2024-06-30
    year INTEGER NOT NULL,
    quarter INTEGER NOT NULL,
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),
    claims_main_applicant INTEGER,
    claims_dependants INTEGER,
    claims_total INTEGER,
    claims_in_country INTEGER,  -- claimed after arrival
    claims_at_port INTEGER,  -- claimed at border
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ac_quarter ON asylum_claims(quarter_end DESC);
CREATE INDEX idx_ac_nationality ON asylum_claims(nationality_id);

-- Asylum decisions by nationality (Asy_D02)
CREATE TABLE asylum_decisions (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    year INTEGER NOT NULL,
    quarter INTEGER NOT NULL,
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),
    decisions_total INTEGER,
    granted_asylum INTEGER,
    granted_hp INTEGER,  -- Humanitarian Protection
    granted_dl INTEGER,  -- Discretionary Leave
    granted_uasc_leave INTEGER,
    grants_total INTEGER,
    refused INTEGER,
    withdrawn INTEGER,
    grant_rate_pct DECIMAL(5,2),
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ad_quarter ON asylum_decisions(quarter_end DESC);
CREATE INDEX idx_ad_nationality ON asylum_decisions(nationality_id);

-- Asylum backlog / awaiting decision (Asy_D03)
CREATE TABLE asylum_backlog (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    total_awaiting INTEGER NOT NULL,
    awaiting_initial INTEGER,
    awaiting_further_review INTEGER,
    awaiting_less_6_months INTEGER,
    awaiting_6_12_months INTEGER,
    awaiting_1_3_years INTEGER,
    awaiting_3_plus_years INTEGER,
    legacy_cases INTEGER,  -- pre-June 2022
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(snapshot_date)
);

CREATE INDEX idx_ab_date ON asylum_backlog(snapshot_date DESC);

-- Asylum backlog by nationality
CREATE TABLE asylum_backlog_nationality (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),
    total_awaiting INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Age disputes (Asy_D06)
CREATE TABLE age_disputes (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    disputes_raised INTEGER,
    resolved_adult INTEGER,
    resolved_child INTEGER,
    pending INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- ASYLUM SUPPORT DATA (Regional & LA Level)
-- =============================================================================

-- Asylum support regional (Asy_D09)
CREATE TABLE asylum_support_regional (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    region VARCHAR(100) NOT NULL,
    total_supported INTEGER NOT NULL,
    section_95 INTEGER,
    section_4 INTEGER,
    dispersed INTEGER,
    initial_accommodation INTEGER,
    hotel INTEGER,
    subsistence_only INTEGER,
    main_applicants INTEGER,
    dependants INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_asr_date ON asylum_support_regional(snapshot_date DESC);
CREATE INDEX idx_asr_region ON asylum_support_regional(region);

-- Asylum support by Local Authority (Asy_D11) - THE KEY TABLE
CREATE TABLE asylum_support_la (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    la_id INTEGER REFERENCES local_authorities(id),
    la_name VARCHAR(255),
    region VARCHAR(100),
    
    -- Totals
    total_supported INTEGER NOT NULL,
    
    -- By support type
    section_95 INTEGER,  -- asylum pending
    section_4 INTEGER,   -- failed, destitute
    section_98 INTEGER,  -- emergency
    
    -- By accommodation type
    dispersed INTEGER,
    initial_accommodation INTEGER,
    hotel INTEGER,
    subsistence_only INTEGER,
    
    -- Demographics
    main_applicants INTEGER,
    dependants INTEGER,
    
    -- Calculated fields (populated by trigger/view)
    per_10k_population DECIMAL(8,2),
    national_share_pct DECIMAL(5,2),
    hotel_share_pct DECIMAL(5,2),
    qoq_change_pct DECIMAL(6,2),
    yoy_change_pct DECIMAL(6,2),
    
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_asla_date ON asylum_support_la(snapshot_date DESC);
CREATE INDEX idx_asla_la ON asylum_support_la(la_id);
CREATE INDEX idx_asla_region ON asylum_support_la(region);

-- =============================================================================
-- APPEALS & TRIBUNAL (4 sources)
-- =============================================================================

-- Asylum appeals (HMCTS FIA tables)
CREATE TABLE asylum_appeals (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    year INTEGER,
    quarter INTEGER,
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),
    appeals_lodged INTEGER,
    appeals_determined INTEGER,
    appeals_allowed INTEGER,
    appeals_dismissed INTEGER,
    appeals_withdrawn INTEGER,
    success_rate_pct DECIMAL(5,2),
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_aa_quarter ON asylum_appeals(quarter_end DESC);

-- Tribunal backlog
CREATE TABLE tribunal_backlog (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    outstanding_appeals INTEGER,
    receipts_ytd INTEGER,
    disposals_ytd INTEGER,
    clearance_rate_pct DECIMAL(5,2),
    avg_weeks_to_hearing DECIMAL(5,1),
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(snapshot_date)
);

-- =============================================================================
-- DETENTION (10 sources)
-- =============================================================================

-- Detention population (Det_D01, Det_D02)
CREATE TABLE detention_population (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    facility_id INTEGER REFERENCES detention_facilities(id),
    facility_name VARCHAR(255),
    population INTEGER NOT NULL,
    capacity INTEGER,
    occupancy_pct DECIMAL(5,2),
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_dp_date ON detention_population(snapshot_date DESC);
CREATE INDEX idx_dp_facility ON detention_population(facility_id);

-- Detention by nationality
CREATE TABLE detention_nationality (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),
    population INTEGER,
    share_pct DECIMAL(5,2),
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Detention length distribution (Det_D03)
CREATE TABLE detention_length (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    length_bracket VARCHAR(50),  -- '0-7 days', '8-14 days', etc.
    bracket_order INTEGER,
    count INTEGER,
    share_pct DECIMAL(5,2),
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Detention outcomes (Det_D03)
CREATE TABLE detention_outcomes (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    outcome detention_outcome,
    count INTEGER,
    share_pct DECIMAL(5,2),
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Rule 35 reports - torture/trafficking indicators (Det_D04)
CREATE TABLE detention_rule35 (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    facility_id INTEGER REFERENCES detention_facilities(id),
    reports_made INTEGER,
    released_following INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deaths in detention
CREATE TABLE detention_deaths (
    id SERIAL PRIMARY KEY,
    date DATE,
    year INTEGER NOT NULL,
    facility_id INTEGER REFERENCES detention_facilities(id),
    cause_category VARCHAR(100),
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Self-harm in detention
CREATE TABLE detention_self_harm (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    facility_id INTEGER REFERENCES detention_facilities(id),
    incidents INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Use of force in detention
CREATE TABLE detention_use_of_force (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    facility_id INTEGER REFERENCES detention_facilities(id),
    incidents INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- RETURNS & REMOVALS (5 sources)
-- =============================================================================

-- Returns by type and nationality (Ret_D01)
CREATE TABLE returns (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    year INTEGER,
    quarter INTEGER,
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),
    return_type return_type,
    count INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ret_quarter ON returns(quarter_end DESC);
CREATE INDEX idx_ret_nationality ON returns(nationality_id);

-- Failed removal attempts
CREATE TABLE failed_removals (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),
    attempts INTEGER,
    reason VARCHAR(255),
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Foreign National Offender deportations
CREATE TABLE fno_deportations (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),
    offence_type VARCHAR(255),
    count INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- UASC - UNACCOMPANIED CHILDREN (4 sources)
-- =============================================================================

-- UASC claims (Asy_D07)
CREATE TABLE uasc_claims (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),
    claims INTEGER,
    age_under_14 INTEGER,
    age_14_15 INTEGER,
    age_16_17 INTEGER,
    male INTEGER,
    female INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- UASC by Local Authority
CREATE TABLE uasc_la (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    la_id INTEGER REFERENCES local_authorities(id),
    la_name VARCHAR(255),
    uasc_count INTEGER,
    care_leavers INTEGER,
    national_transfer_in INTEGER,
    national_transfer_out INTEGER,
    per_10k_child_population DECIMAL(8,2),
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- MODERN SLAVERY / NRM (4 sources)
-- =============================================================================

-- NRM referrals
CREATE TABLE nrm_referrals (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),
    exploitation exploitation_type,
    referrals INTEGER,
    referral_source VARCHAR(100),  -- police, immigration, NGO, etc.
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- NRM decisions
CREATE TABLE nrm_decisions (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),
    outcome nrm_outcome,
    count INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- RESETTLEMENT & SAFE ROUTES (8 sources)
-- =============================================================================

-- Resettlement schemes (ACRS, ARAP, UKRS)
CREATE TABLE resettlement (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    scheme VARCHAR(50) NOT NULL,  -- 'ACRS', 'ARAP', 'UKRS', 'VPRS'
    arrivals INTEGER,
    total_since_start INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Resettlement by Local Authority
CREATE TABLE resettlement_la (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    la_id INTEGER REFERENCES local_authorities(id),
    la_name VARCHAR(255),
    scheme VARCHAR(50),
    placements INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Homes for Ukraine
CREATE TABLE ukraine_arrivals (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    visa_applications INTEGER,
    visas_issued INTEGER,
    arrivals INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(snapshot_date)
);

-- Ukraine by Local Authority
CREATE TABLE ukraine_la (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    la_id INTEGER REFERENCES local_authorities(id),
    la_name VARCHAR(255),
    arrivals INTEGER,
    currently_sponsored INTEGER,
    rematches INTEGER,
    homelessness_presentations INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Family reunion visas (Fam_D01)
CREATE TABLE family_reunion (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),
    applications INTEGER,
    grants INTEGER,
    refusals INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- INADMISSIBILITY & THIRD COUNTRY (3 sources)
-- =============================================================================

CREATE TABLE inadmissibility (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),
    decisions INTEGER,
    returned INTEGER,
    granted_after_review INTEGER,
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- BORDER FORCE (3 sources)
-- =============================================================================

CREATE TABLE border_refusals (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),
    refusals INTEGER,
    port_type VARCHAR(50),  -- air, sea, rail
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- FOREIGN NATIONAL PRISONERS (MoJ) (3 sources)
-- =============================================================================

CREATE TABLE foreign_national_prisoners (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    nationality_id INTEGER REFERENCES nationalities(id),
    nationality_name VARCHAR(255),
    prison_population INTEGER,
    share_of_total_pct DECIMAL(5,2),
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE fno_by_offence (
    id SERIAL PRIMARY KEY,
    quarter_end DATE NOT NULL,
    offence_category VARCHAR(255),
    count INTEGER,
    share_pct DECIMAL(5,2),
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- SPENDING DATA (7 sources)
-- =============================================================================

-- Total asylum system spending
CREATE TABLE spending_annual (
    id SERIAL PRIMARY KEY,
    financial_year VARCHAR(10) NOT NULL,  -- '2024-25'
    fy_start DATE,
    fy_end DATE,
    
    -- Top-level
    total_spend_millions DECIMAL(10,1),
    
    -- Breakdown
    accommodation_spend DECIMAL(10,1),
    hotel_spend DECIMAL(10,1),
    dispersed_spend DECIMAL(10,1),
    initial_accommodation_spend DECIMAL(10,1),
    detention_removals_spend DECIMAL(10,1),
    appeals_tribunal_spend DECIMAL(10,1),
    legal_aid_spend DECIMAL(10,1),
    uasc_grants_spend DECIMAL(10,1),
    other_spend DECIMAL(10,1),
    
    -- Per-person calculations
    avg_supported_population INTEGER,
    cost_per_person DECIMAL(10,0),
    cost_per_decision DECIMAL(10,0),
    
    source VARCHAR(255),  -- 'NAO', 'Home Office accounts', etc.
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(financial_year)
);

-- Hotel cost tracking
CREATE TABLE hotel_costs (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    hotel_population INTEGER,
    cost_per_night DECIMAL(8,2),
    dispersed_cost_per_night DECIMAL(8,2),
    premium_multiple DECIMAL(5,2),  -- hotel/dispersed ratio
    annual_hotel_cost_millions DECIMAL(10,1),
    potential_saving_millions DECIMAL(10,1),  -- if all moved to dispersed
    source VARCHAR(255),
    ingest_run_id UUID REFERENCES ingest_runs(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- COMPUTED / MATERIALIZED VIEWS
-- =============================================================================

-- LA Pressure Index (composite score)
CREATE TABLE pressure_index (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    la_id INTEGER REFERENCES local_authorities(id),
    la_name VARCHAR(255),
    
    -- Component scores (0-100)
    per_capita_score DECIMAL(5,2),
    hotel_share_score DECIMAL(5,2),
    growth_score DECIMAL(5,2),
    deprivation_score DECIMAL(5,2),
    
    -- Composite
    pressure_index DECIMAL(5,2),  -- weighted average
    pressure_rank INTEGER,
    pressure_quintile INTEGER,  -- 1=lowest, 5=highest
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(snapshot_date, la_id)
);

-- Auto-generated insights
CREATE TABLE auto_insights (
    id SERIAL PRIMARY KEY,
    generated_date DATE NOT NULL,
    insight_type VARCHAR(50),  -- 'la_outlier', 'trend', 'milestone', etc.
    subject VARCHAR(255),  -- LA name, nationality, etc.
    metric VARCHAR(100),
    headline TEXT NOT NULL,
    detail TEXT,
    magnitude DECIMAL(10,2),  -- for ranking importance
    expires_at DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- FUNCTIONS & TRIGGERS
-- =============================================================================

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to relevant tables
CREATE TRIGGER update_data_sources_updated_at
    BEFORE UPDATE ON data_sources
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_local_authorities_updated_at
    BEFORE UPDATE ON local_authorities
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Calculate per-capita and change metrics for asylum support LA
CREATE OR REPLACE FUNCTION calculate_la_metrics()
RETURNS TRIGGER AS $$
DECLARE
    pop INTEGER;
    national_total INTEGER;
    prev_quarter_total INTEGER;
    prev_year_total INTEGER;
BEGIN
    -- Get LA population
    SELECT population INTO pop FROM local_authorities WHERE id = NEW.la_id;
    
    -- Calculate per 10k
    IF pop > 0 THEN
        NEW.per_10k_population := (NEW.total_supported::DECIMAL / pop) * 10000;
    END IF;
    
    -- Get national total for this snapshot
    SELECT SUM(total_supported) INTO national_total 
    FROM asylum_support_la 
    WHERE snapshot_date = NEW.snapshot_date AND id != NEW.id;
    
    IF national_total > 0 THEN
        NEW.national_share_pct := (NEW.total_supported::DECIMAL / (national_total + NEW.total_supported)) * 100;
    END IF;
    
    -- Hotel share
    IF NEW.total_supported > 0 THEN
        NEW.hotel_share_pct := (COALESCE(NEW.hotel, 0)::DECIMAL / NEW.total_supported) * 100;
    END IF;
    
    -- QoQ change
    SELECT total_supported INTO prev_quarter_total
    FROM asylum_support_la
    WHERE la_id = NEW.la_id 
      AND snapshot_date = NEW.snapshot_date - INTERVAL '3 months'
    LIMIT 1;
    
    IF prev_quarter_total > 0 THEN
        NEW.qoq_change_pct := ((NEW.total_supported - prev_quarter_total)::DECIMAL / prev_quarter_total) * 100;
    END IF;
    
    -- YoY change
    SELECT total_supported INTO prev_year_total
    FROM asylum_support_la
    WHERE la_id = NEW.la_id 
      AND snapshot_date = NEW.snapshot_date - INTERVAL '1 year'
    LIMIT 1;
    
    IF prev_year_total > 0 THEN
        NEW.yoy_change_pct := ((NEW.total_supported - prev_year_total)::DECIMAL / prev_year_total) * 100;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER calculate_la_metrics_trigger
    BEFORE INSERT OR UPDATE ON asylum_support_la
    FOR EACH ROW EXECUTE FUNCTION calculate_la_metrics();

-- =============================================================================
-- SEED DATA: Data Sources Registry
-- =============================================================================

INSERT INTO data_sources (code, name, frequency, tier, parser_type, url) VALUES
-- Tier A: Live/Weekly
('SBA_DAILY', 'Small Boat Arrivals Daily', 'daily', 'A', 'html', 'https://www.gov.uk/government/publications/migrants-detected-crossing-the-english-channel-in-small-boats/migrants-detected-crossing-the-english-channel-in-small-boats-last-7-days'),
('SBA_WEEKLY', 'Small Boat Time Series Weekly', 'weekly', 'A', 'ods', 'https://www.gov.uk/government/statistical-data-sets/irregular-migration-detailed-dataset-and-summary-tables'),
('FRENCH_PREV', 'French Prevention Activity', 'weekly', 'A', 'ods', 'https://www.gov.uk/government/statistical-data-sets/irregular-migration-detailed-dataset-and-summary-tables'),

-- Tier B: Quarterly Core Asylum
('ASY_D01', 'Asylum Claims by Nationality', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),
('ASY_D02', 'Asylum Decisions by Nationality', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),
('ASY_D03', 'Asylum Backlog', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),
('ASY_D06', 'Age Disputes', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),
('ASY_D07', 'UASC Claims', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),
('ASY_D09', 'Asylum Support Regional', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),
('ASY_D11', 'Asylum Support by LA', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),

-- Tier B: Appeals
('HMCTS_FIA', 'Asylum Appeals', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistics/tribunal-statistics-quarterly'),

-- Tier B: Detention
('DET_D01', 'Detention Population', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),
('DET_D02', 'Detention by Facility', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),
('DET_D03', 'Detention Length & Outcomes', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),
('DET_D04', 'Rule 35 Reports', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),

-- Tier B: Returns
('RET_D01', 'Returns by Type', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),
('RET_D02', 'Assisted Voluntary Returns', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),

-- Tier B: Irregular Entry
('IRR_D02', 'Irregular Entry by Nationality', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/irregular-migration-detailed-dataset-and-summary-tables'),

-- Tier B: NRM
('NRM_STATS', 'Modern Slavery NRM', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistics/modern-slavery-national-referral-mechanism-and-duty-to-notify-statistics'),

-- Tier B: Resettlement
('RES_D01', 'Resettlement Schemes', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),
('RES_D02', 'Resettlement by LA', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),
('UKRAINE', 'Homes for Ukraine', 'weekly', 'A', 'csv', 'https://www.gov.uk/guidance/homes-for-ukraine-sponsor-guidance'),

-- Tier B: Family
('FAM_D01', 'Family Reunion', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables'),

-- Tier C: Annual
('NAO_ASYLUM', 'NAO Asylum Spending Analysis', 'annually', 'C', 'manual', 'https://www.nao.org.uk'),
('HO_ACCOUNTS', 'Home Office Annual Accounts', 'annually', 'C', 'manual', 'https://www.gov.uk/government/collections/home-office-annual-reports-and-accounts'),
('MOJ_FNP', 'Foreign National Prisoners', 'quarterly', 'B', 'ods', 'https://www.gov.uk/government/statistics/offender-management-statistics-quarterly'),

-- Reference Data
('ONS_POP', 'LA Population Estimates', 'annually', 'C', 'csv', 'https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/populationestimates'),
('ONS_GEO', 'LA Boundaries GeoJSON', 'static', 'C', 'geojson', 'https://geoportal.statistics.gov.uk'),
('IMD_2019', 'Index of Multiple Deprivation', 'static', 'C', 'csv', 'https://www.gov.uk/government/statistics/english-indices-of-deprivation-2019');

-- =============================================================================
-- SEED DATA: Detention Facilities
-- =============================================================================

INSERT INTO detention_facilities (code, name, type, operator, capacity) VALUES
('HARM', 'Harmondsworth IRC', 'IRC', 'Mitie', 676),
('COLNBR', 'Colnbrook IRC', 'IRC', 'Mitie', 360),
('BROOK', 'Brook House IRC', 'IRC', 'Serco', 448),
('TINSLEY', 'Tinsley House IRC', 'IRC', 'Serco', 161),
('YARLS', 'Yarls Wood IRC', 'IRC', 'Serco', 410),
('DUNGAVEL', 'Dungavel IRC', 'IRC', 'GEO Group', 249),
('MORTON', 'Morton Hall IRC', 'IRC', 'HMPPS', 392),
('DERWENT', 'Derwentside IRC', 'IRC', 'Mitie', 80),
('MANSTON', 'Manston STHF', 'STHF', 'Home Office', 1600);

-- =============================================================================
-- USEFUL VIEWS
-- =============================================================================

-- Latest LA support snapshot with all metrics
CREATE VIEW v_la_support_latest AS
SELECT 
    asl.*,
    la.ons_code,
    la.population,
    la.imd_rank,
    la.imd_score,
    la.centroid_lat,
    la.centroid_lng
FROM asylum_support_la asl
JOIN local_authorities la ON asl.la_id = la.id
WHERE asl.snapshot_date = (SELECT MAX(snapshot_date) FROM asylum_support_la);

-- Grant rates by nationality with trend
CREATE VIEW v_grant_rates AS
SELECT 
    ad.quarter_end,
    ad.nationality_name,
    ad.grants_total,
    ad.decisions_total,
    ad.grant_rate_pct,
    LAG(ad.grant_rate_pct) OVER (PARTITION BY ad.nationality_id ORDER BY ad.quarter_end) as prev_quarter_rate,
    ad.grant_rate_pct - LAG(ad.grant_rate_pct) OVER (PARTITION BY ad.nationality_id ORDER BY ad.quarter_end) as rate_change
FROM asylum_decisions ad
WHERE ad.decisions_total >= 10  -- Minimum sample size
ORDER BY ad.quarter_end DESC, ad.decisions_total DESC;

-- National totals time series
CREATE VIEW v_national_totals AS
SELECT 
    snapshot_date,
    SUM(total_supported) as total_supported,
    SUM(section_95) as section_95,
    SUM(section_4) as section_4,
    SUM(dispersed) as dispersed,
    SUM(hotel) as hotel,
    SUM(initial_accommodation) as initial_accommodation,
    SUM(subsistence_only) as subsistence_only,
    ROUND(SUM(hotel)::DECIMAL / NULLIF(SUM(total_supported), 0) * 100, 1) as hotel_pct
FROM asylum_support_la
GROUP BY snapshot_date
ORDER BY snapshot_date DESC;

-- Spending efficiency
CREATE VIEW v_spending_efficiency AS
SELECT 
    financial_year,
    total_spend_millions,
    hotel_spend,
    avg_supported_population,
    cost_per_person,
    ROUND(hotel_spend / NULLIF(total_spend_millions, 0) * 100, 1) as hotel_share_pct,
    LAG(total_spend_millions) OVER (ORDER BY financial_year) as prev_year_spend,
    ROUND((total_spend_millions - LAG(total_spend_millions) OVER (ORDER BY financial_year)) / 
          NULLIF(LAG(total_spend_millions) OVER (ORDER BY financial_year), 0) * 100, 1) as yoy_change_pct
FROM spending_annual
ORDER BY financial_year DESC;

-- =============================================================================
-- INDEXES FOR COMMON QUERIES
-- =============================================================================

CREATE INDEX idx_asylum_claims_quarter_nat ON asylum_claims(quarter_end, nationality_id);
CREATE INDEX idx_asylum_decisions_quarter_nat ON asylum_decisions(quarter_end, nationality_id);
CREATE INDEX idx_returns_quarter_nat ON returns(quarter_end, nationality_id);
CREATE INDEX idx_nrm_quarter_nat ON nrm_referrals(quarter_end, nationality_id);
CREATE INDEX idx_pressure_la_date ON pressure_index(la_id, snapshot_date DESC);
