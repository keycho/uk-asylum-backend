import express from 'express';
import cors from 'cors';
import pg from 'pg';
import axios from 'axios';
import * as cheerio from 'cheerio';
import Parser from 'rss-parser';

const { Pool } = pg;
const rssParser = new Parser();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  GOV_UK_SMALL_BOATS: 'https://www.gov.uk/government/publications/migrants-detected-crossing-the-english-channel-in-small-boats',
  GOV_UK_LAST_7_DAYS: 'https://www.gov.uk/government/publications/migrants-detected-crossing-the-english-channel-in-small-boats/migrants-detected-crossing-the-english-channel-in-small-boats-last-7-days',
  HANSARD_RSS: 'https://hansard.parliament.uk/rss/Commons.rss',
  WHATDOTHEYKNOW_ASYLUM: 'https://www.whatdotheyknow.com/feed/search/asylum%20seeker',
  GUARDIAN_IMMIGRATION: 'https://www.theguardian.com/uk/immigration/rss',
  BBC_NEWS: 'https://feeds.bbci.co.uk/news/uk/rss.xml',
  CONTRACTS_FINDER: 'https://www.contractsfinder.service.gov.uk/api/rest/2/search_notices/json',
  COMPANIES_HOUSE: 'https://api.company-information.service.gov.uk',
  ELECTORAL_COMMISSION: 'https://search.electoralcommission.org.uk/api/search',
  CACHE_DURATION_MS: 5 * 60 * 1000,
  SCRAPE_INTERVAL_MS: 60 * 60 * 1000,
};

// ============================================================================
// IN-MEMORY CACHE
// ============================================================================

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache: Map<string, CacheEntry<any>> = new Map();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CONFIG.CACHE_DURATION_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

// ============================================================================
// CONTRACTOR PROFILES - DEEP DATA
// ============================================================================

const contractorProfiles = {
  clearsprings: {
    id: 'clearsprings',
    name: 'Clearsprings Ready Homes',
    legal_name: 'Clearsprings Ready Homes Ltd',
    companies_house_number: '03961498',
    parent_company: 'Clearsprings (Management) Ltd',
    
    ownership: {
      type: 'Private',
      majority_owner: 'Graham King',
      ownership_pct: 99.4,
      other_shareholders: ['Minor family holdings']
    },
    
    contract: {
      name: 'AASC (Asylum Accommodation and Support Contract)',
      regions: ['South of England', 'Wales'],
      start_date: '2019-09-01',
      end_date: '2029-09-01',
      original_value_millions: 1000,
      current_value_millions: 7300, // Revalued
      value_increase_pct: 630,
      daily_value: 4800000, // £4.8M/day
    },
    
    financials: {
      currency: 'GBP',
      fiscal_year_end: 'January',
      data: [
        { year: '2020', revenue_m: 180, profit_m: 12, margin_pct: 6.7, dividends_m: 8 },
        { year: '2021', revenue_m: 320, profit_m: 22, margin_pct: 6.9, dividends_m: 15 },
        { year: '2022', revenue_m: 580, profit_m: 42, margin_pct: 7.2, dividends_m: 30 },
        { year: '2023', revenue_m: 890, profit_m: 74.4, margin_pct: 8.4, dividends_m: 62.5 },
        { year: '2024', revenue_m: 1300, profit_m: 119.4, margin_pct: 9.2, dividends_m: 90 },
      ],
      total_profit_2019_2024: 270,
      total_dividends_2019_2024: 205,
    },
    
    profit_clawback: {
      cap_pct: 5,
      actual_margin_pct: 6.9,
      excess_owed_millions: 32,
      paid_back_millions: 0,
      status: 'Pending audit',
      source: 'Home Affairs Committee May 2025'
    },
    
    accommodation: {
      people_housed: 45000,
      hotels_managed: 120,
      dispersed_properties: 8500,
      large_sites: ['Napier Barracks (closed Sep 2025)', 'Wethersfield'],
    },
    
    performance: {
      complaints_2023: 4200,
      complaints_pct_of_total: 45, // Highest of the 3 contractors
      inspection_failures: 23,
      service_credits_deducted_millions: 1.2,
    },
    
    controversies: [
      {
        date: '2016',
        issue: 'Red wristbands for asylum seekers in Cardiff',
        outcome: 'Practice scrapped after public outcry'
      },
      {
        date: '2019',
        issue: 'Dire living conditions in Southall - pests, overcrowding',
        outcome: 'Home Office ordered urgent action'
      },
      {
        date: '2021',
        issue: 'Napier Barracks fire, hunger strikes, suicide attempts',
        outcome: 'Red Cross called for closure'
      },
      {
        date: '2022',
        issue: 'Bed bugs, ceiling collapse in London hotels',
        outcome: 'Some residents moved'
      },
      {
        date: '2024',
        issue: '£16M paid to offshore company - flagged by MPs',
        outcome: 'Under investigation'
      },
      {
        date: '2024',
        issue: '£58M in unsupported invoices identified by NAO',
        outcome: 'Audit ongoing'
      }
    ],
    
    subcontractors: {
      known: [
        {
          name: 'Stay Belvedere Hotels Ltd',
          hotels: 51,
          status: 'Terminated March 2025',
          reason: 'Poor performance'
        }
      ],
      last_updated: '2019', // Home Office lists 5 years out of date
      note: 'Home Office does not maintain current subcontractor records'
    },
    
    sources: [
      { name: 'Companies House Filing', url: 'https://find-and-update.company-information.service.gov.uk/company/03961498' },
      { name: 'NAO Report May 2025', url: 'https://www.nao.org.uk/reports/home-offices-asylum-accommodation-contracts/' },
      { name: 'Home Affairs Committee', url: 'https://committees.parliament.uk/work/8252/asylum-accommodation/' },
      { name: 'Prospect Magazine Investigation', url: 'https://www.prospectmagazine.co.uk/politics/policy/immigration/67175/britains-asylum-king-graham-king-clearsprings-home-office-asylum-immigration' }
    ]
  },
  
  serco: {
    id: 'serco',
    name: 'Serco',
    legal_name: 'Serco Ltd',
    companies_house_number: '02048608',
    parent_company: 'Serco Group PLC',
    stock_ticker: 'SRP.L',
    
    ownership: {
      type: 'Public (FTSE 250)',
      market_cap_millions: 2600,
      major_shareholders: ['Institutional investors']
    },
    
    contract: {
      name: 'AASC (Asylum Accommodation and Support Contract)',
      regions: ['Midlands', 'East of England', 'North West'],
      start_date: '2019-09-01',
      end_date: '2029-09-01',
      original_value_millions: 1900,
      current_value_millions: 5500,
      value_increase_pct: 189,
    },
    
    financials: {
      currency: 'GBP',
      note: 'Asylum is subset of wider Serco UK operations',
      asylum_revenue_estimate_annual: 800,
      group_data: [
        { year: '2021', uk_revenue_m: 2100, uk_profit_m: 89 },
        { year: '2022', uk_revenue_m: 2400, uk_profit_m: 112 },
        { year: '2023', uk_revenue_m: 2800, uk_profit_m: 145 },
        { year: '2024', uk_revenue_m: 3100, uk_profit_m: 168 },
      ],
      asylum_margin_pct: 2.8, // NAO figure
    },
    
    profit_clawback: {
      cap_pct: 5,
      status: 'Has not triggered profit-sharing threshold',
      paid_back_millions: 0,
      source: 'Home Affairs Committee May 2025'
    },
    
    accommodation: {
      people_housed: 35000,
      hotels_managed: 109,
      dispersed_properties: 12000,
    },
    
    performance: {
      complaints_2023: 2800,
      service_credits_deducted_millions: 1.5,
    },
    
    other_government_contracts: [
      'Prison management',
      'Defence support services',
      'Citizen services',
      'NHS contracts',
      'Transport (Northern Rail franchise - ended)'
    ],
    
    controversies: [
      {
        date: '2013',
        issue: 'Electronic tagging fraud - charged for tagging dead people',
        outcome: '£68.5M repaid, SFO investigation'
      },
      {
        date: '2017',
        issue: 'Yarl\'s Wood sexual abuse allegations',
        outcome: 'ICIBI investigation'
      },
      {
        date: '2022',
        issue: 'Culture of abuse and intimidation reported at asylum sites',
        outcome: 'Guardian investigation'
      },
      {
        date: '2024',
        issue: 'Germany subsidiary ORS making 50-66% gross margins',
        outcome: 'ARD/ZDF investigation'
      }
    ],
    
    sources: [
      { name: 'Serco Annual Report', url: 'https://www.serco.com/investors' },
      { name: 'Companies House', url: 'https://find-and-update.company-information.service.gov.uk/company/02048608' },
      { name: 'NAO Report May 2025', url: 'https://www.nao.org.uk/reports/home-offices-asylum-accommodation-contracts/' }
    ]
  },
  
  mears: {
    id: 'mears',
    name: 'Mears Group',
    legal_name: 'Mears Group PLC',
    companies_house_number: '03711395',
    stock_ticker: 'MER.L',
    
    ownership: {
      type: 'Public (AIM)',
      market_cap_millions: 450,
    },
    
    contract: {
      name: 'AASC (Asylum Accommodation and Support Contract)',
      regions: ['Scotland', 'Northern Ireland', 'North East', 'Yorkshire'],
      start_date: '2019-09-01',
      end_date: '2029-09-01',
      original_value_millions: 1600,
      current_value_millions: 2500,
      value_increase_pct: 56,
    },
    
    financials: {
      currency: 'GBP',
      data: [
        { year: '2021', revenue_m: 980, profit_m: 28, margin_pct: 2.9 },
        { year: '2022', revenue_m: 1050, profit_m: 38, margin_pct: 3.6 },
        { year: '2023', revenue_m: 1100, profit_m: 45, margin_pct: 4.1 },
        { year: '2024', revenue_m: 1150, profit_m: 52, margin_pct: 4.5 },
      ],
      asylum_margin_pct: 4.6, // NAO figure
    },
    
    profit_clawback: {
      cap_pct: 5,
      excess_owed_millions: 13.8,
      paid_back_millions: 0,
      status: 'Awaiting final clearance',
      source: 'Home Affairs Committee May 2025'
    },
    
    accommodation: {
      people_housed: 30000,
      hotels_managed: 80,
      dispersed_properties: 9500,
    },
    
    performance: {
      complaints_2023: 1900,
      service_credits_deducted_millions: 1.3,
      profit_increase_2021: 37, // 37% rise in profits
    },
    
    other_services: [
      'Social housing maintenance',
      'Care services',
      'Housing management'
    ],
    
    controversies: [
      {
        date: '2020',
        issue: 'Glasgow housing - 6 asylum seekers in one room',
        outcome: 'Legal challenge'
      },
      {
        date: '2021',
        issue: 'Park Inn Glasgow stabbing incident - accommodation conditions cited',
        outcome: 'Inquiry'
      }
    ],
    
    sources: [
      { name: 'Mears Annual Report', url: 'https://www.mearsgroup.co.uk/investors/' },
      { name: 'Companies House', url: 'https://find-and-update.company-information.service.gov.uk/company/03711395' },
      { name: 'NAO Report May 2025', url: 'https://www.nao.org.uk/reports/home-offices-asylum-accommodation-contracts/' }
    ]
  }
};

// ============================================================================
// KEY INDIVIDUALS
// ============================================================================

const keyIndividuals = {
  graham_king: {
    id: 'graham_king',
    name: 'Graham King',
    title: 'Founder & Owner',
    company: 'Clearsprings Ready Homes',
    ownership_pct: 99.4,
    
    wealth: {
      currency: 'GBP',
      timeline: [
        { year: 2023, net_worth_millions: 500, source: 'Estimate' },
        { year: 2024, net_worth_millions: 750, rich_list_rank: 221, source: 'Sunday Times Rich List' },
        { year: 2025, net_worth_millions: 1015, rich_list_rank: 154, source: 'Sunday Times Rich List' },
      ],
      yoy_increase_pct: 35,
      wealth_source: 'Holiday parks, inheritance, housing asylum seekers for the government',
      first_billionaire_year: 2025,
      nickname: 'The Asylum King'
    },
    
    background: {
      birthplace: 'Canvey Island, Essex',
      family_business: 'Father Jack ran caravan park (sold for £32M in 2007)',
      residences: ['Mayfair, London', 'Monaco'],
      hobbies: ['Porsche Sprint Challenge racing'],
      family: 'Brother Jeff also lives in Monaco'
    },
    
    political_connections: {
      donations: [
        {
          year: 2001,
          amount: 3000,
          recipient: 'Conservative Party',
          via: 'Thorney Bay Park (company he directed)',
          source: 'Electoral Commission'
        }
      ],
      note: 'Has not given public interviews'
    },
    
    controversies: [
      {
        issue: '£16M paid to company not registered in UK',
        year: 2024,
        detail: 'Flagged by MPs as potential offshore tax arrangement',
        source: 'Home Affairs Committee'
      },
      {
        issue: 'Tripadvisor complaint about Italian hotel while housing asylum seekers in substandard UK hotels',
        year: 2023,
        detail: 'Complained about musty smell and old fittings at luxury hotel',
        source: 'Prospect Magazine investigation'
      }
    ],
    
    sources: [
      { name: 'Sunday Times Rich List 2025', url: 'https://www.thetimes.co.uk/sunday-times-rich-list' },
      { name: 'Prospect Magazine', url: 'https://www.prospectmagazine.co.uk/politics/policy/immigration/67175/britains-asylum-king-graham-king-clearsprings-home-office-asylum-immigration' },
      { name: 'Companies House', url: 'https://find-and-update.company-information.service.gov.uk/' }
    ]
  },
  
  alex_langsam: {
    id: 'alex_langsam',
    name: 'Alex Langsam',
    title: 'Owner',
    company: 'Britannia Hotels',
    
    wealth: {
      currency: 'GBP',
      net_worth_millions: 401,
      source: 'Sunday Times Rich List 2025'
    },
    
    notes: {
      hotel_rating: 'Voted worst UK hotel chain for 11 consecutive years by Which?',
      asylum_involvement: 'Multiple Britannia hotels used for asylum accommodation'
    }
  }
};

// ============================================================================
// UNIT COST BREAKDOWN - THE £145 QUESTION
// ============================================================================

const unitCostBreakdown = {
  last_updated: '2025-05-01',
  source: 'NAO Report May 2025, Home Office data',
  
  hotel_accommodation: {
    home_office_pays: 145,
    unit: 'per person per night',
    
    breakdown_estimate: {
      actual_room_cost: 65, // Market rack rate estimate
      food_provision: 25,
      security: 20,
      management_fee: 15,
      transport: 10,
      contractor_margin: 10,
      total: 145
    },
    
    context: {
      market_hotel_rate: '£50-80/night typical',
      markup_estimate: '80-100%',
      note: 'Exact breakdown not published by Home Office'
    },
    
    scale: {
      people_in_hotels: 38000,
      daily_hotel_cost: 5510000, // 38,000 × £145
      annual_hotel_cost_millions: 2011,
      pct_of_total_spend: 76
    }
  },
  
  dispersed_accommodation: {
    home_office_pays: 52,
    unit: 'per person per night',
    
    breakdown_estimate: {
      property_lease: 30,
      utilities: 8,
      maintenance: 6,
      management: 5,
      contractor_margin: 3,
      total: 52
    },
    
    scale: {
      people_in_dispersed: 72000,
      daily_dispersed_cost: 3744000,
      annual_dispersed_cost_millions: 1367
    }
  },
  
  comparison: {
    hotel_vs_dispersed_ratio: 2.8, // Hotels cost 2.8x more
    hotel_pct_of_people: 35,
    hotel_pct_of_cost: 76,
    inefficiency_note: 'Hotels house 35% of people but consume 76% of budget'
  },
  
  what_145_could_buy: {
    context: '£145/night = £52,925/year per person',
    alternatives: [
      { item: 'Private rental (national average)', weekly_cost: 280, annual: 14560 },
      { item: 'Social housing rent', weekly_cost: 100, annual: 5200 },
      { item: 'Budget hotel (Travelodge)', nightly_cost: 45, annual: 16425 },
    ],
    savings_potential: {
      if_all_dispersed: 'Would save ~£2.3B annually',
      barrier: 'Not enough dispersed housing available'
    }
  }
};

// ============================================================================
// CONTRACT OVERVIEW - THE BIG PICTURE
// ============================================================================

const contractOverview = {
  programme_name: 'Asylum Accommodation and Support Contracts (AASC)',
  awarded: '2019-01',
  duration_years: 10,
  end_date: '2029-09',
  
  original_estimate: {
    total_millions: 4500,
    annual_millions: 450,
    basis: '2019 projection of asylum volumes'
  },
  
  current_estimate: {
    total_millions: 15300,
    annual_millions: 1700,
    daily_millions: 4.66,
    as_of: '2025-05'
  },
  
  cost_explosion: {
    increase_millions: 10800,
    increase_pct: 240,
    reasons: [
      'COVID-19 disruption',
      'Record small boat arrivals (2021-2024)',
      'Asylum backlog growth (62k → 130k → now clearing)',
      'Reliance on expensive hotel accommodation',
      'Lack of dispersed housing availability'
    ]
  },
  
  by_contractor: [
    { 
      name: 'Clearsprings', 
      original_millions: 1000, 
      current_millions: 7300,
      increase_pct: 630,
      daily_millions: 4.8
    },
    { 
      name: 'Serco', 
      original_millions: 1900, 
      current_millions: 5500,
      increase_pct: 189
    },
    { 
      name: 'Mears', 
      original_millions: 1600, 
      current_millions: 2500,
      increase_pct: 56
    }
  ],
  
  total_profit_extracted: {
    period: '2019-2024',
    amount_millions: 383,
    margin_pct: 7,
    note: 'Across all three contractors'
  },
  
  clawback_status: {
    total_owed_millions: 45.8,
    total_recovered_millions: 74, // Nov 2025 clawback
    mechanism: '5% profit cap - excess to be returned',
    enforcement: 'Poor - first recovery only in Nov 2025'
  },
  
  penalties: {
    service_credits_deducted_millions: 4,
    pct_of_revenue: 0.3,
    note: 'Less than 1% of supplier revenue penalised since 2019'
  },
  
  sources: [
    { name: 'NAO May 2025 Report', url: 'https://www.nao.org.uk/reports/home-offices-asylum-accommodation-contracts/' },
    { name: 'Home Affairs Committee', url: 'https://committees.parliament.uk/work/8252/asylum-accommodation/' }
  ]
};

// ============================================================================
// ACCOUNTABILITY FAILURES
// ============================================================================

const accountabilityFailures = {
  last_updated: '2025-05',
  
  oversight_gaps: [
    {
      issue: 'Subcontractor lists 5 years out of date',
      detail: 'Home Office last updated subcontractor records in 2019',
      impact: 'Cannot track who actually provides accommodation',
      source: 'OpenDemocracy/Liberty Investigates FOI'
    },
    {
      issue: 'Inspections down 45%',
      detail: '378/month (2016-18) → 208/month (2024)',
      impact: 'Reduced oversight of accommodation quality',
      source: 'ICIBI reports'
    },
    {
      issue: 'No centralised performance data',
      detail: 'Home Office cannot produce aggregate contractor performance metrics',
      impact: 'Cannot compare or benchmark contractors',
      source: 'FOI response May 2024'
    },
    {
      issue: 'Compliance data not recorded',
      detail: 'Home Office "currently working on developing a system" to record inspection compliance',
      impact: 'No historical record of standards breaches',
      source: 'FOI response May 2024'
    },
    {
      issue: '£58M unsupported invoices',
      detail: 'NAO found potentially unsupported charges in Clearsprings invoices 2023-24',
      impact: 'Taxpayer may have overpaid',
      source: 'NAO Report May 2025'
    }
  ],
  
  profit_extraction: {
    dividends_paid_2019_2024_millions: 121,
    while_conditions_criticised: true,
    profit_cap_enforcement: 'Weak - no money recovered until Nov 2025',
    mp_quote: "You haven't paid a pound back into the Home Office"
  },
  
  home_office_response: {
    standard_line: 'Accommodation meets all legal and contractual requirements',
    actions_taken: [
      'Terminated Stay Belvedere Hotels contract (Mar 2025)',
      'Recovered £74M in Nov 2025 audit',
      'Pledged to close all asylum hotels by end of parliament'
    ]
  }
};

// ============================================================================
// POLITICAL CONNECTIONS
// ============================================================================

const politicalConnections = {
  donations: [
    {
      donor: 'Graham King (via Thorney Bay Park)',
      recipient: 'Conservative Party',
      amount: 3000,
      year: 2001,
      source: 'Electoral Commission'
    }
  ],
  
  revolving_door: [
    {
      name: 'Note',
      detail: 'Specific revolving door instances require further FOI research',
      status: 'To be populated'
    }
  ],
  
  lobbying: {
    serco_us_lobbying_2024: 200000, // USD
    uk_lobbying: 'Not separately disclosed',
    source: 'OpenSecrets (US data)'
  },
  
  note: 'Electoral Commission API can be queried for comprehensive donation data'
};

// ============================================================================
// DATA SOURCES REGISTRY
// ============================================================================

const DATA_SOURCES = {
  small_boats: {
    name: 'Small Boat Crossings',
    source: 'GOV.UK Home Office',
    url: 'https://www.gov.uk/government/publications/migrants-detected-crossing-the-english-channel-in-small-boats',
    update_frequency: 'Every few days',
    last_updated: '2025-11-27'
  },
  la_support: {
    name: 'Local Authority Asylum Support',
    source: 'Home Office Immigration Statistics - Table Asy_D11',
    url: 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables#asylum-and-resettlement',
    update_frequency: 'Quarterly',
    last_updated: '2025-09-30'
  },
  contractors: {
    name: 'Contractor Financials',
    sources: [
      { name: 'Companies House', url: 'https://find-and-update.company-information.service.gov.uk/', api: true },
      { name: 'NAO Reports', url: 'https://www.nao.org.uk/reports/' },
      { name: 'Annual Reports', note: 'Serco, Mears (public), Clearsprings (Companies House)' }
    ],
    update_frequency: 'Annual (accounts), Ad-hoc (NAO)',
    last_updated: '2025-05-01'
  },
  contracts: {
    name: 'Contract Awards',
    source: 'Contracts Finder',
    url: 'https://www.contractsfinder.service.gov.uk/',
    api: 'https://www.contractsfinder.service.gov.uk/api/rest/2/search_notices/json',
    update_frequency: 'Continuous',
    last_updated: 'Live'
  },
  political_donations: {
    name: 'Political Donations',
    source: 'Electoral Commission',
    url: 'https://search.electoralcommission.org.uk/',
    api: true,
    update_frequency: 'Quarterly',
    last_updated: '2025-Q3'
  },
  spending: {
    name: 'Asylum Spending',
    source: 'NAO Reports, Home Office Annual Accounts',
    url: 'https://www.nao.org.uk/reports/home-offices-asylum-accommodation-contracts/',
    update_frequency: 'Annual',
    last_updated: '2025-05-01'
  },
  returns: {
    name: 'Returns and Deportations',
    source: 'Home Office Immigration Statistics',
    url: 'https://www.gov.uk/government/statistics/immigration-system-statistics-year-ending-december-2024',
    update_frequency: 'Quarterly',
    last_updated: '2025-03-01'
  },
  net_migration: {
    name: 'Net Migration',
    source: 'ONS',
    url: 'https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/internationalmigration',
    update_frequency: 'Quarterly',
    last_updated: '2025-11-27'
  },
  appeals: {
    name: 'Asylum Appeals',
    source: 'Ministry of Justice Tribunal Statistics',
    url: 'https://www.gov.uk/government/statistics/tribunal-statistics-quarterly',
    update_frequency: 'Quarterly',
    last_updated: '2025-12-12'
  },
  channel_deaths: {
    name: 'Channel Crossing Deaths',
    sources: [
      { name: 'IOM Missing Migrants', url: 'https://missingmigrants.iom.int/' },
      { name: 'INQUEST', url: 'https://www.inquest.org.uk/' }
    ],
    update_frequency: 'As reported',
    last_updated: '2025-12-31'
  },
  rwanda: {
    name: 'Rwanda Scheme',
    sources: [
      { name: 'NAO Investigation', url: 'https://www.nao.org.uk/reports/investigation-into-the-costs-of-the-uk-rwanda-partnership/' },
      { name: 'Home Secretary Statement', url: 'https://hansard.parliament.uk/commons/2024-07-22/debates/D7D7A102-E96C-45EB-B77B-FA0B65809498/RwandaScheme' }
    ],
    update_frequency: 'Historical',
    last_updated: '2025-01-15'
  }
};

// ============================================================================
// FRANCE RETURNS DEAL
// ============================================================================

const franceReturnsDeal = {
  announced: '2025-07-10',
  first_return: '2025-09-18',
  status: 'Active - Pilot Phase',
  target_weekly: 50,
  target_annual: 2600,
  
  actual_returns: {
    total_returned_to_france: 12,
    total_accepted_from_france: 8,
    as_of_date: '2025-12-31',
    monthly: [
      { month: '2025-09', returned: 1, accepted: 0 },
      { month: '2025-10', returned: 4, accepted: 3 },
      { month: '2025-11', returned: 4, accepted: 3 },
      { month: '2025-12', returned: 3, accepted: 2 },
    ]
  },
  
  effectiveness: {
    crossings_since_deal: 28000,
    returns_achieved: 12,
    return_rate_pct: 0.04
  }
};

// ============================================================================
// RETURNS DATA
// ============================================================================

const returnsData = {
  data_period: '2024',
  source: 'Home Office Immigration Statistics',
  
  summary: {
    total_returns: 34978,
    enforced_returns: 8590,
    voluntary_returns: 26388,
  },
  
  small_boat_returns: {
    arrivals_2018_2024: 130000,
    returned_in_period: 3900,
    return_rate_pct: 3
  },
  
  by_nationality: [
    { nationality: 'India', total: 8500, enforced: 1200 },
    { nationality: 'Albania', total: 4800, enforced: 2100 },
    { nationality: 'Brazil', total: 4500, enforced: 290 },
    { nationality: 'Romania', total: 2100, enforced: 850 },
    { nationality: 'China', total: 1800, enforced: 620 },
  ]
};

// ============================================================================
// NET MIGRATION DATA
// ============================================================================

const netMigrationData = {
  data_period: 'Year ending June 2025',
  source: 'ONS',
  
  latest: {
    immigration: 898000,
    emigration: 693000,
    net_migration: 204000,
  },
  
  historical: [
    { period: 'YE Jun 2019', net: 255000 },
    { period: 'YE Jun 2022', net: 620000 },
    { period: 'YE Mar 2023', net: 909000, note: 'Peak' },
    { period: 'YE Jun 2024', net: 649000 },
    { period: 'YE Jun 2025', net: 204000 },
  ]
};

// ============================================================================
// APPEALS DATA
// ============================================================================

const appealsData = {
  data_period: 'Q3 2025',
  source: 'Ministry of Justice',
  
  backlog: {
    total_pending: 32500,
    trend: 'increasing'
  },
  
  outcomes: {
    allowed_pct: 52,
    dismissed_pct: 42,
    withdrawn_pct: 6
  },
  
  processing: {
    average_wait_weeks: 52,
    cases_waiting_over_1_year: 17000
  }
};

// ============================================================================
// CHANNEL DEATHS
// ============================================================================

const channelDeathsData = {
  last_updated: '2025-12-31',
  
  summary: {
    total_since_2018: 350,
    year_2025: 72,
    year_2024: 58,
    deadliest_year: 2025
  },
  
  annual: [
    { year: 2018, deaths: 4 },
    { year: 2019, deaths: 6 },
    { year: 2020, deaths: 8 },
    { year: 2021, deaths: 33 },
    { year: 2022, deaths: 45 },
    { year: 2023, deaths: 52 },
    { year: 2024, deaths: 58 },
    { year: 2025, deaths: 72 },
  ],
  
  demographics: {
    children: 28,
    women: 42
  }
};

// ============================================================================
// SPENDING DATA
// ============================================================================

const spendingData = {
  annual: [
    { financial_year: '2019-20', total_spend_millions: 850, hotel: 45 },
    { financial_year: '2020-21', total_spend_millions: 1210, hotel: 180 },
    { financial_year: '2021-22', total_spend_millions: 1710, hotel: 400 },
    { financial_year: '2022-23', total_spend_millions: 3070, hotel: 1200 },
    { financial_year: '2023-24', total_spend_millions: 4030, hotel: 1800 },
    { financial_year: '2024-25', total_spend_millions: 4700, hotel: 1650 },
  ],
  
  budget_vs_actual: [
    { year: '2021-22', budget: 1200, actual: 1710, overspend_pct: 42.5 },
    { year: '2022-23', budget: 1800, actual: 3070, overspend_pct: 70.6 },
    { year: '2023-24', budget: 2800, actual: 4030, overspend_pct: 43.9 },
    { year: '2024-25', budget: 4200, actual: 4700, overspend_pct: 11.9 },
  ],
  
  unit_costs: {
    hotel: { cost: 145, unit: 'per person per night' },
    dispersed: { cost: 52, unit: 'per person per night' },
    detention: { cost: 115, unit: 'per person per day' },
  },
  
  rwanda: {
    total_cost_millions: 700,
    forced_deportations: 0,
    voluntary_relocations: 4,
    cost_per_relocation_millions: 175,
    status: 'Scrapped January 2025',
    sources: [
      { name: 'NAO Investigation', url: 'https://www.nao.org.uk/reports/investigation-into-the-costs-of-the-uk-rwanda-partnership/' },
      { name: 'Home Secretary Statement', url: 'https://hansard.parliament.uk/commons/2024-07-22/debates/D7D7A102-E96C-45EB-B77B-FA0B65809498/RwandaScheme' }
    ]
  }
};

// ============================================================================
// LOCAL AUTHORITY DATA (Abbreviated - full list in v11)
// ============================================================================

const localAuthoritiesData = [
  { name: 'Glasgow City', ons_code: 'S12000049', region: 'Scotland', population: 635130, total: 3844, hotel: 1180, dispersed: 2200 },
  { name: 'Middlesbrough', ons_code: 'E06000002', region: 'North East', population: 143127, total: 1340, hotel: 220, dispersed: 940 },
  { name: 'Liverpool', ons_code: 'E08000012', region: 'North West', population: 496770, total: 2361, hotel: 480, dispersed: 1560 },
  { name: 'Birmingham', ons_code: 'E08000025', region: 'West Midlands', population: 1157603, total: 2755, hotel: 850, dispersed: 1600 },
  { name: 'Hillingdon', ons_code: 'E09000017', region: 'London', population: 309014, total: 2481, hotel: 2100, dispersed: 230 },
  // ... more LAs would be included from v11
];

// ============================================================================
// IRC FACILITIES
// ============================================================================

const ircFacilities = [
  { id: 'harmondsworth', name: 'Harmondsworth IRC', operator: 'Mitie', capacity: 615, population: 520, location: { lat: 51.4875, lng: -0.4472 } },
  { id: 'colnbrook', name: 'Colnbrook IRC', operator: 'Mitie', capacity: 392, population: 352, location: { lat: 51.4722, lng: -0.4861 } },
  { id: 'brook-house', name: 'Brook House IRC', operator: 'Serco', capacity: 448, population: 380, location: { lat: 51.1527, lng: -0.1769 } },
  { id: 'yarls-wood', name: "Yarl's Wood IRC", operator: 'Serco', capacity: 410, population: 280, location: { lat: 52.1144, lng: -0.4667 } },
  { id: 'dungavel', name: 'Dungavel IRC', operator: 'GEO Group', capacity: 249, population: 180, location: { lat: 55.6833, lng: -4.0833 } },
];

// ============================================================================
// COMMUNITY TIPS
// ============================================================================

let communityTips: any[] = [
  {
    id: 'tip-001',
    type: 'hotel_sighting',
    title: 'Premier Inn Croydon - Asylum Accommodation',
    content: 'Large group arriving with security presence.',
    location: { name: 'Premier Inn Croydon', local_authority: 'Croydon' },
    submitted_at: '2026-01-28T14:30:00Z',
    verified: false,
    upvotes: 23,
    downvotes: 2,
    status: 'investigating'
  }
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function calculateAreaCost(hotel: number, dispersed: number) {
  const dailyCost = (hotel * 145) + (dispersed * 52);
  return {
    daily: dailyCost,
    annual: dailyCost * 365,
    breakdown: {
      hotel: { count: hotel, rate: 145, daily: hotel * 145 },
      dispersed: { count: dispersed, rate: 52, daily: dispersed * 52 }
    }
  };
}

function getEnforcementScorecard() {
  return {
    period: '2025 YTD',
    arrivals_vs_returns: {
      small_boat_arrivals_2025: 52000,
      france_deal_returns: franceReturnsDeal.actual_returns.total_returned_to_france,
      all_enforced_returns_2024: returnsData.summary.enforced_returns,
    },
    policy_effectiveness: [
      {
        policy: 'Rwanda Scheme',
        cost_millions: 700,
        forced_deportations: 0,
        voluntary_relocations: 4,
        status: 'Scrapped Jan 2025'
      },
      {
        policy: 'France Returns Deal',
        returns: franceReturnsDeal.actual_returns.total_returned_to_france,
        target: 2600,
        achievement_pct: 0.5,
        status: 'Active - underperforming'
      },
      {
        policy: 'Voluntary Returns',
        returns_2024: 26388,
        status: 'Primary mechanism'
      }
    ]
  };
}

// ============================================================================
// CHANNEL WEATHER
// ============================================================================

async function getChannelConditions() {
  const cached = getCached<any>('channel_weather');
  if (cached) return cached;

  try {
    const doverUrl = 'https://api.open-meteo.com/v1/forecast?latitude=51.1279&longitude=1.3134&current=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation,weather_code&timezone=Europe/London';
    const marineUrl = 'https://marine-api.open-meteo.com/v1/marine?latitude=51.05&longitude=1.5&current=wave_height&timezone=Europe/London';
    
    const [weatherRes, marineRes] = await Promise.all([
      axios.get(doverUrl),
      axios.get(marineUrl)
    ]);
    
    const weather = weatherRes.data.current;
    const marine = marineRes.data.current;
    
    let riskScore = 0;
    if (weather.wind_speed_10m < 15) riskScore += 3;
    else if (weather.wind_speed_10m < 25) riskScore += 2;
    if (marine.wave_height < 0.5) riskScore += 2;
    else if (marine.wave_height < 1.0) riskScore += 1;
    if (weather.precipitation === 0) riskScore += 1;
    
    let risk: string;
    if (riskScore >= 5) risk = 'VERY_HIGH';
    else if (riskScore >= 3) risk = 'HIGH';
    else if (riskScore >= 1) risk = 'MODERATE';
    else risk = 'LOW';
    
    const data = {
      timestamp: new Date().toISOString(),
      temperature_c: weather.temperature_2m,
      wind_speed_kmh: weather.wind_speed_10m,
      wave_height_m: marine.wave_height,
      crossing_risk: risk,
      source: 'Open-Meteo API'
    };

    setCache('channel_weather', data);
    return data;
  } catch (error) {
    return { crossing_risk: 'UNKNOWN', source: 'Open-Meteo API' };
  }
}

// ============================================================================
// DATABASE INIT
// ============================================================================

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS detention_facilities (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(100),
        operator VARCHAR(255),
        capacity INTEGER,
        population INTEGER,
        lat DECIMAL(10, 6),
        lng DECIMAL(10, 6)
      )
    `);
    console.log('Database initialized');
  } catch (error) {
    console.error('Database init error:', error);
  }
}

// ============================================================================
// API ENDPOINTS - CONTRACTORS (NEW)
// ============================================================================

app.get('/api/contractors', (req, res) => {
  const summary = Object.values(contractorProfiles).map((c: any) => ({
    id: c.id,
    name: c.name,
    contract_value_millions: c.contract.current_value_millions,
    profit_margin_pct: c.id === 'clearsprings' ? c.financials.data[4].margin_pct : 
                       c.financials.asylum_margin_pct,
    people_housed: c.accommodation.people_housed,
    regions: c.contract.regions,
    clawback_owed_millions: c.profit_clawback.excess_owed_millions || 0,
    clawback_paid_millions: c.profit_clawback.paid_back_millions
  }));
  
  res.json({
    contractors: summary,
    totals: {
      contract_value_millions: 15300,
      profit_extracted_millions: 383,
      clawback_owed_millions: 45.8,
      clawback_paid_millions: 74
    },
    source: 'NAO May 2025 Report'
  });
});

app.get('/api/contractors/:id', (req, res) => {
  const contractor = (contractorProfiles as any)[req.params.id];
  if (!contractor) return res.status(404).json({ error: 'Contractor not found' });
  res.json(contractor);
});

app.get('/api/contractors/:id/financials', (req, res) => {
  const contractor = (contractorProfiles as any)[req.params.id];
  if (!contractor) return res.status(404).json({ error: 'Contractor not found' });
  res.json({
    name: contractor.name,
    financials: contractor.financials,
    profit_clawback: contractor.profit_clawback
  });
});

app.get('/api/contractors/:id/controversies', (req, res) => {
  const contractor = (contractorProfiles as any)[req.params.id];
  if (!contractor) return res.status(404).json({ error: 'Contractor not found' });
  res.json({
    name: contractor.name,
    controversies: contractor.controversies,
    complaints_2023: contractor.performance.complaints_2023
  });
});

// ============================================================================
// API ENDPOINTS - KEY INDIVIDUALS
// ============================================================================

app.get('/api/individuals', (req, res) => {
  const summary = Object.values(keyIndividuals).map((i: any) => ({
    id: i.id,
    name: i.name,
    company: i.company,
    net_worth_millions: i.wealth.timeline ? 
      i.wealth.timeline[i.wealth.timeline.length - 1].net_worth_millions :
      i.wealth.net_worth_millions,
    is_billionaire: i.wealth.first_billionaire_year ? true : false
  }));
  res.json(summary);
});

app.get('/api/individuals/:id', (req, res) => {
  const individual = (keyIndividuals as any)[req.params.id];
  if (!individual) return res.status(404).json({ error: 'Individual not found' });
  res.json(individual);
});

app.get('/api/individuals/graham_king/wealth', (req, res) => {
  const gk = keyIndividuals.graham_king as any;
  res.json({
    name: gk.name,
    current_net_worth_millions: gk.wealth.timeline[gk.wealth.timeline.length - 1].net_worth_millions,
    is_billionaire: true,
    first_billionaire_year: gk.wealth.first_billionaire_year,
    wealth_timeline: gk.wealth.timeline,
    yoy_increase_pct: gk.wealth.yoy_increase_pct,
    wealth_source: gk.wealth.wealth_source,
    nickname: gk.wealth.nickname
  });
});

// ============================================================================
// API ENDPOINTS - UNIT COSTS
// ============================================================================

app.get('/api/costs/breakdown', (req, res) => {
  res.json(unitCostBreakdown);
});

app.get('/api/costs/145-question', (req, res) => {
  const hotel = unitCostBreakdown.hotel_accommodation;
  res.json({
    headline: 'Where does £145/night go?',
    home_office_pays: hotel.home_office_pays,
    market_rate: hotel.context.market_hotel_rate,
    markup_estimate: hotel.context.markup_estimate,
    breakdown_estimate: hotel.breakdown_estimate,
    scale: hotel.scale,
    inefficiency: unitCostBreakdown.comparison,
    note: 'Exact breakdown not published by Home Office - this is NAO/estimate based'
  });
});

// ============================================================================
// API ENDPOINTS - CONTRACT OVERVIEW
// ============================================================================

app.get('/api/contracts/overview', (req, res) => {
  res.json(contractOverview);
});

app.get('/api/contracts/cost-explosion', (req, res) => {
  res.json({
    original_estimate_millions: contractOverview.original_estimate.total_millions,
    current_estimate_millions: contractOverview.current_estimate.total_millions,
    increase_millions: contractOverview.cost_explosion.increase_millions,
    increase_pct: contractOverview.cost_explosion.increase_pct,
    reasons: contractOverview.cost_explosion.reasons,
    by_contractor: contractOverview.by_contractor
  });
});

// ============================================================================
// API ENDPOINTS - ACCOUNTABILITY
// ============================================================================

app.get('/api/accountability', (req, res) => {
  res.json(accountabilityFailures);
});

app.get('/api/accountability/clawback', (req, res) => {
  res.json({
    mechanism: '5% profit cap - excess must be returned to Home Office',
    by_contractor: [
      { name: 'Clearsprings', owed_millions: 32, paid_millions: 0, status: 'Pending audit' },
      { name: 'Mears', owed_millions: 13.8, paid_millions: 0, status: 'Awaiting clearance' },
      { name: 'Serco', owed_millions: 0, paid_millions: 0, status: 'Below threshold' }
    ],
    total_owed_millions: 45.8,
    total_recovered_millions: 74,
    mp_quote: "You haven't paid a pound back into the Home Office",
    source: 'Home Affairs Committee May 2025'
  });
});

// ============================================================================
// API ENDPOINTS - POLITICAL CONNECTIONS
// ============================================================================

app.get('/api/political', (req, res) => {
  res.json(politicalConnections);
});

// ============================================================================
// API ENDPOINTS - EXISTING (from v11)
// ============================================================================

app.get('/api/sources', (req, res) => {
  res.json({ sources: DATA_SOURCES });
});

app.get('/api/france-deal', (req, res) => {
  res.json(franceReturnsDeal);
});

app.get('/api/france-deal/summary', (req, res) => {
  res.json({
    status: franceReturnsDeal.status,
    returns_to_france: franceReturnsDeal.actual_returns.total_returned_to_france,
    target_annual: franceReturnsDeal.target_annual,
    achievement_pct: ((franceReturnsDeal.actual_returns.total_returned_to_france / franceReturnsDeal.target_annual) * 100).toFixed(1),
    crossings_since_deal: franceReturnsDeal.effectiveness.crossings_since_deal,
    return_rate_pct: franceReturnsDeal.effectiveness.return_rate_pct
  });
});

app.get('/api/returns', (req, res) => {
  res.json(returnsData);
});

app.get('/api/net-migration', (req, res) => {
  res.json(netMigrationData);
});

app.get('/api/appeals', (req, res) => {
  res.json(appealsData);
});

app.get('/api/deaths', (req, res) => {
  res.json(channelDeathsData);
});

app.get('/api/enforcement', (req, res) => {
  res.json(getEnforcementScorecard());
});

app.get('/api/ircs', (req, res) => {
  res.json({ facilities: ircFacilities });
});

app.get('/api/spending', (req, res) => {
  res.json(spendingData);
});

app.get('/api/spending/rwanda', (req, res) => {
  res.json({
    ...spendingData.rwanda,
    summary: '£700M total cost. 0 forced deportations. 4 voluntary relocations. Scrapped January 2025.'
  });
});

app.get('/api/la', (req, res) => {
  const enriched = localAuthoritiesData.map(la => ({
    ...la,
    per_10k: ((la.total / la.population) * 10000).toFixed(2),
    daily_cost: (la.hotel * 145) + (la.dispersed * 52)
  }));
  res.json({ data: enriched, count: enriched.length });
});

app.get('/api/cost/area/:la', (req, res) => {
  const la = localAuthoritiesData.find(
    l => l.name.toLowerCase() === req.params.la.toLowerCase()
  );
  if (!la) return res.status(404).json({ error: 'Local authority not found' });
  
  const costs = calculateAreaCost(la.hotel, la.dispersed);
  const annual = costs.annual;
  
  res.json({
    local_authority: la.name,
    population: la.population,
    asylum_seekers: la.total,
    costs: {
      daily: costs.daily,
      daily_formatted: `£${costs.daily.toLocaleString()}`,
      annual: annual,
      annual_formatted: `£${(annual / 1000000).toFixed(2)}M`,
      breakdown: costs.breakdown
    },
    equivalents: {
      nurses: Math.floor(annual / 35000),
      teachers: Math.floor(annual / 42000),
      police_officers: Math.floor(annual / 45000),
      school_meals: Math.floor(annual / 2.5),
    }
  });
});

app.get('/api/channel-conditions', async (req, res) => {
  const conditions = await getChannelConditions();
  res.json(conditions);
});

app.get('/api/community/tips', (req, res) => {
  res.json({ total: communityTips.length, items: communityTips });
});

app.post('/api/community/tips', (req, res) => {
  const { type, title, content, location } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Missing fields' });
  
  const newTip = {
    id: `tip-${Date.now()}`,
    type: type || 'other',
    title,
    content,
    location,
    submitted_at: new Date().toISOString(),
    verified: false,
    upvotes: 0,
    downvotes: 0,
    status: 'pending'
  };
  communityTips.push(newTip);
  res.status(201).json({ message: 'Tip submitted', id: newTip.id });
});

// ============================================================================
// API ENDPOINTS - DASHBOARD SUMMARY
// ============================================================================

app.get('/api/dashboard/summary', async (req, res) => {
  const weather = await getChannelConditions();
  
  res.json({
    small_boats: {
      ytd: 45183,
      year: 2025
    },
    channel: {
      risk: weather.crossing_risk
    },
    spending: {
      total_contract_value_billions: 15.3,
      daily_rate_millions: 4.66
    },
    contractors: {
      profit_extracted_millions: 383,
      clawback_owed_millions: 45.8,
      graham_king_net_worth_millions: 1015
    },
    france_deal: {
      returns: franceReturnsDeal.actual_returns.total_returned_to_france,
      target: franceReturnsDeal.target_annual
    },
    appeals_backlog: appealsData.backlog.total_pending,
    deaths_2025: channelDeathsData.summary.year_2025,
    rwanda: {
      cost_millions: 700,
      forced_deportations: 0,
      voluntary_relocations: 4,
      status: 'Scrapped'
    }
  });
});

// ============================================================================
// HEALTH & ROOT
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    version: '12.0.0',
    features: [
      'contractor_profiles', 'key_individuals', 'unit_cost_breakdown',
      'contract_overview', 'accountability_failures', 'political_connections',
      'profit_clawback_tracker', 'france_deal', 'returns', 'net_migration',
      'appeals', 'deaths', 'enforcement_scorecard', 'cost_calculator'
    ],
    timestamp: new Date().toISOString() 
  });
});

app.get('/', (req, res) => {
  res.json({ 
    name: 'UK Asylum Tracker API',
    version: '12.0',
    description: 'Follow the money - contractor accountability edition',
    new_in_v12: [
      'Deep contractor profiles (Clearsprings, Serco, Mears)',
      'Graham King wealth tracker',
      'Unit cost breakdown (the £145 question)',
      'Contract cost explosion analysis',
      'Profit clawback tracker',
      'Accountability failures log',
      'Political connections',
      'Subcontractor visibility'
    ],
    endpoints: {
      contractors: [
        '/api/contractors',
        '/api/contractors/:id',
        '/api/contractors/:id/financials',
        '/api/contractors/:id/controversies'
      ],
      individuals: [
        '/api/individuals',
        '/api/individuals/graham_king',
        '/api/individuals/graham_king/wealth'
      ],
      costs: [
        '/api/costs/breakdown',
        '/api/costs/145-question'
      ],
      contracts: [
        '/api/contracts/overview',
        '/api/contracts/cost-explosion'
      ],
      accountability: [
        '/api/accountability',
        '/api/accountability/clawback'
      ],
      political: ['/api/political'],
      existing: [
        '/api/france-deal', '/api/returns', '/api/net-migration',
        '/api/appeals', '/api/deaths', '/api/enforcement',
        '/api/spending', '/api/la', '/api/ircs'
      ]
    }
  });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 UK Asylum Tracker API v12 running on port ${PORT}`);
      console.log('NEW: Contractor Accountability Module');
      console.log('  ✓ Deep contractor profiles');
      console.log('  ✓ Graham King wealth tracker');
      console.log('  ✓ £145/night breakdown');
      console.log('  ✓ Profit clawback tracker');
      console.log('  ✓ Accountability failures');
    });
  })
  .catch(err => {
    console.error('Failed to initialize:', err);
    process.exit(1);
  });
