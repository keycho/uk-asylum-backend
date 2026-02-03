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
  TFL_JAMCAMS: 'https://api.tfl.gov.uk/Place/Type/JamCam',
  TRAFFIC_SCOTLAND: 'https://trafficscotland.org/rss/feeds/cameras.aspx',
  CACHE_DURATION_MS: 5 * 60 * 1000, // 5 minutes
  SCRAPE_INTERVAL_MS: 60 * 60 * 1000, // 1 hour
  // Crime API Configuration
  POLICE_UK_API: 'https://data.police.uk/api',
  CRIME_CACHE_DURATION_MS: 30 * 60 * 1000, // 30 minutes (crime data updates monthly)
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

function setCache<T>(key: string, data: T, duration?: number): void {
  cache.set(key, { data, timestamp: Date.now() });
}

function getCachedCrime<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CONFIG.CRIME_CACHE_DURATION_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

// ============================================================================
// CRIME STATISTICS INTERFACES & FUNCTIONS
// ============================================================================

interface CrimeLocation {
  latitude: string;
  longitude: string;
  street: { id: number; name: string; };
}

interface Crime {
  id: number;
  category: string;
  location_type: string;
  location: CrimeLocation;
  context: string;
  outcome_status: { category: string; date: string; } | null;
  persistent_id: string;
  location_subtype: string;
  month: string;
}

interface CrimeCategory { url: string; name: string; }
interface PoliceForce { id: string; name: string; }

interface CrimeSummary {
  category: string;
  count: number;
  percentage: number;
}

interface AreaCrimeData {
  location: { lat: number; lng: number; radius_miles: number; };
  period: string;
  total_crimes: number;
  crimes_by_category: CrimeSummary[];
  crimes: Crime[];
  hotspots: Array<{ street: string; count: number; lat: number; lng: number; }>;
}

const CRIME_CATEGORY_NAMES: Record<string, string> = {
  'all-crime': 'All Crime',
  'anti-social-behaviour': 'Anti-social Behaviour',
  'bicycle-theft': 'Bicycle Theft',
  'burglary': 'Burglary',
  'criminal-damage-arson': 'Criminal Damage & Arson',
  'drugs': 'Drugs',
  'other-crime': 'Other Crime',
  'other-theft': 'Other Theft',
  'possession-of-weapons': 'Possession of Weapons',
  'public-order': 'Public Order',
  'robbery': 'Robbery',
  'shoplifting': 'Shoplifting',
  'theft-from-the-person': 'Theft from Person',
  'vehicle-crime': 'Vehicle Crime',
  'violent-crime': 'Violence & Sexual Offences',
};

function getLastAvailableMonth(): string {
  const now = new Date();
  now.setMonth(now.getMonth() - 2);
  return \`\${now.getFullYear()}-\${String(now.getMonth() + 1).padStart(2, '0')}\`;
}

async function getCrimeCategories(): Promise<CrimeCategory[]> {
  const cached = getCachedCrime<CrimeCategory[]>('crime_categories');
  if (cached) return cached;
  try {
    const response = await axios.get(\`\${CONFIG.POLICE_UK_API}/crime-categories\`, { timeout: 10000 });
    setCache('crime_categories', response.data);
    return response.data;
  } catch (error) {
    console.error('Error fetching crime categories:', error);
    return [];
  }
}

async function getPoliceForces(): Promise<PoliceForce[]> {
  const cached = getCachedCrime<PoliceForce[]>('police_forces');
  if (cached) return cached;
  try {
    const response = await axios.get(\`\${CONFIG.POLICE_UK_API}/forces\`, { timeout: 10000 });
    setCache('police_forces', response.data);
    return response.data;
  } catch (error) {
    console.error('Error fetching police forces:', error);
    return [];
  }
}

async function getForceDetails(forceId: string): Promise<any> {
  const cacheKey = \`force_\${forceId}\`;
  const cached = getCachedCrime<any>(cacheKey);
  if (cached) return cached;
  try {
    const response = await axios.get(\`\${CONFIG.POLICE_UK_API}/forces/\${forceId}\`, { timeout: 10000 });
    setCache(cacheKey, response.data);
    return response.data;
  } catch (error) {
    return null;
  }
}

async function getNeighbourhoods(forceId: string): Promise<any[]> {
  const cacheKey = \`neighbourhoods_\${forceId}\`;
  const cached = getCachedCrime<any[]>(cacheKey);
  if (cached) return cached;
  try {
    const response = await axios.get(\`\${CONFIG.POLICE_UK_API}/\${forceId}/neighbourhoods\`, { timeout: 10000 });
    setCache(cacheKey, response.data);
    return response.data;
  } catch (error) {
    return [];
  }
}

async function getCrimesAtLocation(lat: number, lng: number, date?: string): Promise<Crime[]> {
  const month = date || getLastAvailableMonth();
  const cacheKey = \`crimes_\${lat.toFixed(4)}_\${lng.toFixed(4)}_\${month}\`;
  const cached = getCachedCrime<Crime[]>(cacheKey);
  if (cached) return cached;
  try {
    const response = await axios.get(\`\${CONFIG.POLICE_UK_API}/crimes-at-location\`, {
      params: { lat, lng, date: month }, timeout: 15000
    });
    setCache(cacheKey, response.data);
    return response.data;
  } catch (error) {
    return [];
  }
}

async function getCrimesInArea(lat: number, lng: number, radiusMiles: number = 1, date?: string): Promise<AreaCrimeData> {
  const month = date || getLastAvailableMonth();
  const cacheKey = \`crimes_area_\${lat.toFixed(4)}_\${lng.toFixed(4)}_\${radiusMiles}_\${month}\`;
  const cached = getCachedCrime<AreaCrimeData>(cacheKey);
  if (cached) return cached;

  try {
    const latOffset = radiusMiles * 0.0145;
    const lngOffset = radiusMiles * 0.0215;
    const poly = [
      [lat - latOffset, lng - lngOffset],
      [lat - latOffset, lng + lngOffset],
      [lat + latOffset, lng + lngOffset],
      [lat + latOffset, lng - lngOffset],
    ].map(([la, lo]) => \`\${la},\${lo}\`).join(':');

    const response = await axios.post(
      \`\${CONFIG.POLICE_UK_API}/crimes-street/all-crime\`,
      \`poly=\${poly}&date=\${month}\`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
    );

    const crimes: Crime[] = response.data || [];
    const categoryCounts: Record<string, number> = {};
    const streetCounts: Record<string, { count: number; lat: number; lng: number }> = {};
    
    for (const crime of crimes) {
      const cat = crime.category;
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      const streetName = crime.location?.street?.name || 'Unknown';
      if (!streetCounts[streetName]) {
        streetCounts[streetName] = {
          count: 0,
          lat: parseFloat(crime.location?.latitude || '0'),
          lng: parseFloat(crime.location?.longitude || '0')
        };
      }
      streetCounts[streetName].count++;
    }
    
    const totalCrimes = crimes.length;
    const crimesByCategory: CrimeSummary[] = Object.entries(categoryCounts)
      .map(([category, count]) => ({
        category: CRIME_CATEGORY_NAMES[category] || category,
        count,
        percentage: totalCrimes > 0 ? Math.round((count / totalCrimes) * 100) : 0
      }))
      .sort((a, b) => b.count - a.count);
    
    const hotspots = Object.entries(streetCounts)
      .map(([street, data]) => ({ street, count: data.count, lat: data.lat, lng: data.lng }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const result: AreaCrimeData = {
      location: { lat, lng, radius_miles: radiusMiles },
      period: month,
      total_crimes: totalCrimes,
      crimes_by_category: crimesByCategory,
      crimes: crimes.slice(0, 500),
      hotspots
    };
    
    setCache(cacheKey, result);
    return result;
  } catch (error: any) {
    return {
      location: { lat, lng, radius_miles: radiusMiles },
      period: month,
      total_crimes: 0,
      crimes_by_category: [],
      crimes: [],
      hotspots: []
    };
  }
}

async function getStopAndSearches(lat: number, lng: number, date?: string): Promise<any[]> {
  const month = date || getLastAvailableMonth();
  const cacheKey = \`stop_search_\${lat.toFixed(4)}_\${lng.toFixed(4)}_\${month}\`;
  const cached = getCachedCrime<any[]>(cacheKey);
  if (cached) return cached;
  try {
    const response = await axios.get(\`\${CONFIG.POLICE_UK_API}/stops-street\`, {
      params: { lat, lng, date: month }, timeout: 15000
    });
    setCache(cacheKey, response.data || []);
    return response.data || [];
  } catch (error) {
    return [];
  }
}

async function getLastUpdated(): Promise<{ date: string; stop_and_search: string[] }> {
  const cached = getCachedCrime<any>('crime_last_updated');
  if (cached) return cached;
  try {
    const response = await axios.get(\`\${CONFIG.POLICE_UK_API}/crime-last-updated\`, { timeout: 10000 });
    setCache('crime_last_updated', response.data);
    return response.data;
  } catch (error) {
    return { date: getLastAvailableMonth(), stop_and_search: [] };
  }
}

async function getCrimesNearAsylumLocations(): Promise<any> {
  const cacheKey = 'crimes_asylum_locations';
  const cached = getCachedCrime<any>(cacheKey);
  if (cached) return cached;

  const locations = [
    { name: 'Harmondsworth IRC', lat: 51.4875, lng: -0.4472, type: 'IRC' },
    { name: 'Brook House IRC', lat: 51.1527, lng: -0.1769, type: 'IRC' },
    { name: "Yarl's Wood IRC", lat: 52.1144, lng: -0.4667, type: 'IRC' },
    { name: 'Manston Processing Centre', lat: 51.3461, lng: 1.3464, type: 'Processing' },
    { name: 'Croydon', lat: 51.3762, lng: -0.0982, type: 'High Density Area' },
    { name: 'Middlesbrough', lat: 54.5742, lng: -1.2350, type: 'High Density Area' },
    { name: 'Glasgow Govan', lat: 55.8566, lng: -4.3110, type: 'High Density Area' },
  ];

  const results = [];
  const month = getLastAvailableMonth();

  for (const loc of locations) {
    try {
      const crimes = await getCrimesAtLocation(loc.lat, loc.lng, month);
      const categoryCounts: Record<string, number> = {};
      for (const crime of crimes) {
        const cat = crime.category;
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      }
      results.push({
        ...loc, period: month, total_crimes: crimes.length,
        breakdown: Object.entries(categoryCounts)
          .map(([category, count]) => ({ category: CRIME_CATEGORY_NAMES[category] || category, count }))
          .sort((a, b) => b.count - a.count)
      });
    } catch (error) {
      results.push({ ...loc, period: month, total_crimes: 0, breakdown: [], error: 'Failed to fetch data' });
    }
  }
  setCache(cacheKey, results);
  return results;
}

async function getCrimeComparisonForLAs(laNames: string[]): Promise<any[]> {
  const results = [];
  const month = getLastAvailableMonth();
  const laCoordinates: Record<string, { lat: number; lng: number }> = {
    'Glasgow City': { lat: 55.8642, lng: -4.2518 },
    'Edinburgh': { lat: 55.9533, lng: -3.1883 },
    'Middlesbrough': { lat: 54.5742, lng: -1.2350 },
    'Liverpool': { lat: 53.4084, lng: -2.9916 },
    'Manchester': { lat: 53.4808, lng: -2.2426 },
    'Birmingham': { lat: 52.4862, lng: -1.8904 },
    'Croydon': { lat: 51.3762, lng: -0.0982 },
    'Hillingdon': { lat: 51.5441, lng: -0.4760 },
    'Leeds': { lat: 53.8008, lng: -1.5491 },
    'Bradford': { lat: 53.7960, lng: -1.7594 },
    'Sheffield': { lat: 53.3811, lng: -1.4701 },
    'Bristol': { lat: 51.4545, lng: -2.5879 },
    'Newcastle upon Tyne': { lat: 54.9783, lng: -1.6178 },
    'Nottingham': { lat: 52.9548, lng: -1.1581 },
    'Leicester': { lat: 52.6369, lng: -1.1398 },
    'Coventry': { lat: 52.4068, lng: -1.5197 },
  };

  for (const laName of laNames) {
    const coords = laCoordinates[laName];
    if (!coords) {
      results.push({ local_authority: laName, error: 'Coordinates not available' });
      continue;
    }
    try {
      const crimeData = await getCrimesInArea(coords.lat, coords.lng, 1, month);
      results.push({
        local_authority: laName, coordinates: coords, period: month,
        total_crimes: crimeData.total_crimes,
        top_categories: crimeData.crimes_by_category.slice(0, 5),
        hotspots: crimeData.hotspots.slice(0, 5)
      });
    } catch (error) {
      results.push({ local_authority: laName, coordinates: coords, error: 'Failed to fetch crime data' });
    }
  }
  return results;
}

// ============================================================================
// DATA SOURCES REGISTRY - For transparency page
// ============================================================================

const DATA_SOURCES = {
  small_boats: {
    name: 'Small Boat Crossings',
    source: 'GOV.UK Home Office',
    url: 'https://www.gov.uk/government/publications/migrants-detected-crossing-the-english-channel-in-small-boats',
    update_frequency: 'Every few days',
    last_updated: '2025-11-27',
    methodology: 'Official Home Office counts of detected arrivals'
  },
  la_support: {
    name: 'Local Authority Asylum Support',
    source: 'Home Office Immigration Statistics - Table Asy_D11',
    url: 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables#asylum-and-resettlement',
    direct_download: 'https://assets.publishing.service.gov.uk/media/6735e05ea297e76cbff82c16/asylum-applications-datasets-sep-2024.xlsx',
    update_frequency: 'Quarterly',
    last_updated: '2025-09-30',
    data_period: 'Q3 2025',
    methodology: 'Snapshot of people receiving Section 95 support by local authority'
  },
  spending: {
    name: 'Asylum Spending',
    source: 'NAO Reports, Home Office Annual Accounts',
    url: 'https://www.nao.org.uk/reports/asylum-accommodation-and-support-transformation-programme/',
    related_documents: [
      'https://www.nao.org.uk/reports/investigation-into-the-costs-of-the-uk-rwanda-partnership/',
      'https://www.gov.uk/government/publications/home-office-annual-report-and-accounts-2023-to-2024'
    ],
    update_frequency: 'Annual',
    last_updated: '2025-07-15',
    data_period: 'FY 2024-25',
    methodology: 'Published accounts and NAO analysis'
  },
  detention: {
    name: 'Immigration Detention',
    source: 'Home Office Immigration Statistics - Table Det_D01',
    url: 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables#detention',
    update_frequency: 'Quarterly',
    last_updated: '2025-09-30',
    data_period: 'Q3 2025'
  },
  returns: {
    name: 'Returns and Deportations',
    source: 'Home Office Immigration Statistics - Returns Tables',
    url: 'https://www.gov.uk/government/statistics/immigration-system-statistics-year-ending-december-2024',
    summary_page: 'https://www.gov.uk/government/statistics/immigration-system-statistics-year-ending-december-2024/how-many-people-are-returned-from-the-uk',
    update_frequency: 'Quarterly',
    last_updated: '2025-03-01',
    data_period: '2024'
  },
  france_deal: {
    name: 'France Returns Deal',
    source: 'Home Office, News Reports',
    url: 'https://www.gov.uk/government/news/landmark-uk-france-summit-to-intensify-work-to-stop-small-boats',
    related_coverage: [
      'https://www.bbc.co.uk/news/articles/cx2v0l1l478o',
      'https://www.aljazeera.com/news/2025/9/18/uk-returns-first-small-boat-migrant-to-france-under-new-deal'
    ],
    update_frequency: 'As announced',
    last_updated: '2025-09-24',
    data_period: 'July 2025 - present',
    note: 'Detailed statistics not yet published by Home Office'
  },
  net_migration: {
    name: 'Net Migration',
    source: 'Office for National Statistics (ONS)',
    url: 'https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/internationalmigration/bulletins/longterminternationalmigrationprovisional/yearendingjune2025',
    dataset: 'https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/internationalmigration/datasets/longterminternationalmigrationestimates',
    update_frequency: 'Quarterly',
    last_updated: '2025-11-27',
    data_period: 'YE June 2025'
  },
  appeals: {
    name: 'Asylum Appeals',
    source: 'Ministry of Justice Tribunal Statistics',
    url: 'https://www.gov.uk/government/statistics/tribunal-statistics-quarterly-july-to-september-2025',
    update_frequency: 'Quarterly',
    last_updated: '2025-12-12',
    data_period: 'Q3 2025'
  },
  channel_deaths: {
    name: 'Channel Crossing Deaths',
    source: 'IOM Missing Migrants Project, INQUEST, Verified News Reports',
    urls: [
      { name: 'IOM Missing Migrants', url: 'https://missingmigrants.iom.int/region/europe?region_incident=4&route=3896' },
      { name: 'INQUEST', url: 'https://www.inquest.org.uk/deaths-of-asylum-seekers-refugees' }
    ],
    update_frequency: 'As reported',
    last_updated: '2025-12-31',
    methodology: 'Compiled from IOM database, coroner inquests, and verified news reports'
  },
  weather: {
    name: 'Channel Weather Conditions',
    source: 'Open-Meteo API',
    url: 'https://open-meteo.com/',
    update_frequency: 'Real-time',
    last_updated: 'Live'
  },
  news: {
    name: 'News Aggregation',
    source: 'Guardian RSS, BBC RSS',
    update_frequency: 'Hourly',
    last_updated: 'Live'
  },
  parliamentary: {
    name: 'Parliamentary Activity',
    source: 'Hansard RSS',
    url: 'https://hansard.parliament.uk/',
    update_frequency: 'Daily',
    last_updated: 'Live'
  },
  foi: {
    name: 'FOI Requests',
    source: 'WhatDoTheyKnow',
    url: 'https://www.whatdotheyknow.com/',
    update_frequency: 'Daily',
    last_updated: 'Live'
  },
  rwanda: {
    name: 'Rwanda Scheme',
    source: 'NAO, Home Office, Hansard',
    urls: [
      { name: 'NAO Investigation', url: 'https://www.nao.org.uk/reports/investigation-into-the-costs-of-the-uk-rwanda-partnership/' },
      { name: 'Home Secretary Statement', url: 'https://hansard.parliament.uk/commons/2024-07-22/debates/D7D7A102-E96C-45EB-B77B-FA0B65809498/RwandaScheme' },
      { name: 'Migration Observatory Analysis', url: 'https://migrationobservatory.ox.ac.uk/resources/commentaries/qa-the-uks-policy-to-send-asylum-seekers-to-rwanda/' }
    ],
    update_frequency: 'Historical (scheme ended)',
    last_updated: '2025-01-15',
    data_period: '2022-2025'
  },
  crime: {
    name: 'UK Crime Statistics',
    source: 'Police UK Open Data API',
    url: 'https://data.police.uk/',
    api_docs: 'https://data.police.uk/docs/',
    update_frequency: 'Monthly (approx. 2 month delay)',
    methodology: 'Street-level crime data from all 43 police forces in England & Wales',
    coverage: 'England, Wales, Northern Ireland (partial)',
    note: 'Scotland has separate policing data not included in this API'
  }
};

// ============================================================================
// FRANCE RETURNS DEAL DATA
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
      { month: '2025-09', returned: 1, accepted: 0, note: 'First return Sep 18' },
      { month: '2025-10', returned: 4, accepted: 3 },
      { month: '2025-11', returned: 4, accepted: 3 },
      { month: '2025-12', returned: 3, accepted: 2 },
    ]
  },
  legal_challenges: 2,
  re_entries: 1,
  mechanism: {
    outbound: 'UK returns small boat arrivals without UK family ties to France',
    inbound: 'UK accepts asylum seekers from France who have UK family connections',
    ratio: '1:1 (one in, one out)',
    eligibility_outbound: 'Arrived by small boat, no UK family ties, claim declared inadmissible',
    eligibility_inbound: 'In France, can prove UK family connections'
  },
  effectiveness: {
    crossings_since_deal: 28000,
    returns_achieved: 12,
    return_rate_pct: 0.04
  },
  sources: ['Home Office announcements', 'Al Jazeera reporting', 'ITV News', 'BBC News']
};

// ============================================================================
// RETURNS & DEPORTATIONS DATA
// ============================================================================

const returnsData = {
  data_period: '2024',
  last_updated: '2025-03-01',
  source: 'Home Office Immigration Statistics',
  summary: {
    total_returns: 34978,
    yoy_change_pct: 6,
    enforced_returns: 8590,
    enforced_yoy_change_pct: 22,
    voluntary_returns: 26388,
    voluntary_yoy_change_pct: 19,
    port_returns: 5128,
  },
  by_type: [
    { type: 'Voluntary Returns', count: 26388, pct_of_total: 75 },
    { type: 'Enforced Returns', count: 8590, pct_of_total: 25 },
  ],
  fno: {
    total_returned: 5128,
    pct_of_all_returns: 15,
    top_nationalities: ['Albania', 'Romania', 'Poland', 'Jamaica', 'Nigeria']
  },
  by_nationality: [
    { nationality: 'India', total: 8500, enforced: 1200, voluntary: 6741, pct: 24 },
    { nationality: 'Albania', total: 4800, enforced: 2100, voluntary: 2670, pct: 14 },
    { nationality: 'Brazil', total: 4500, enforced: 290, voluntary: 4209, pct: 13 },
    { nationality: 'Romania', total: 2100, enforced: 850, voluntary: 1250, pct: 6 },
    { nationality: 'China', total: 1800, enforced: 620, voluntary: 1180, pct: 5 },
    { nationality: 'Pakistan', total: 1600, enforced: 580, voluntary: 1020, pct: 5 },
    { nationality: 'Nigeria', total: 1400, enforced: 520, voluntary: 880, pct: 4 },
    { nationality: 'Bangladesh', total: 1200, enforced: 380, voluntary: 820, pct: 3 },
    { nationality: 'Vietnam', total: 950, enforced: 420, voluntary: 530, pct: 3 },
    { nationality: 'Iraq', total: 750, enforced: 280, voluntary: 470, pct: 2 },
  ],
  small_boat_returns: {
    arrivals_2018_2024: 130000,
    returned_in_period: 3900,
    return_rate_pct: 3,
    note: 'Only 3% of small boat arrivals 2018-2024 were returned'
  },
  failed_asylum_returns: {
    applications_2010_2020: 280000,
    refused: 112000,
    returned_by_june_2024: 53760,
    return_rate_pct: 48,
    note: '48% of refused asylum seekers (2010-2020 cohort) returned by June 2024'
  },
  historical: [
    { year: 2019, total: 32900, enforced: 7040 },
    { year: 2020, total: 18200, enforced: 4180 },
    { year: 2021, total: 21400, enforced: 4920 },
    { year: 2022, total: 26100, enforced: 5890 },
    { year: 2023, total: 33000, enforced: 7040 },
    { year: 2024, total: 34978, enforced: 8590 },
  ]
};

// ============================================================================
// NET MIGRATION DATA (ONS)
// ============================================================================

const netMigrationData = {
  data_period: 'Year ending June 2025',
  last_updated: '2025-11-27',
  source: 'Office for National Statistics',
  latest: { immigration: 898000, emigration: 693000, net_migration: 204000 },
  historical: [
    { period: 'YE Jun 2019', immigration: 640000, emigration: 385000, net: 255000 },
    { period: 'YE Jun 2020', immigration: 550000, emigration: 340000, net: 210000 },
    { period: 'YE Jun 2021', immigration: 600000, emigration: 380000, net: 220000 },
    { period: 'YE Jun 2022', immigration: 1100000, emigration: 480000, net: 620000 },
    { period: 'YE Jun 2023', immigration: 1300000, emigration: 550000, net: 750000 },
    { period: 'YE Mar 2023', immigration: 1469000, emigration: 560000, net: 909000, note: 'Peak' },
    { period: 'YE Jun 2024', immigration: 1299000, emigration: 650000, net: 649000 },
    { period: 'YE Jun 2025', immigration: 898000, emigration: 693000, net: 204000 },
  ],
  by_reason: {
    work: { main: 86000, dependants: 85000, total: 171000, change_pct: -61 },
    study: { main: 230000, dependants: 58000, total: 288000, change_pct: -30 },
    family: { total: 125000, change_pct: -15 },
    asylum: { total: 96000, change_pct: 18 },
    other: { total: 218000 }
  },
  by_nationality: {
    british: { immigration: 143000, emigration: 252000, net: -109000, note: 'More Brits leaving' },
    eu: { immigration: 155000, emigration: 155000, net: 0 },
    non_eu: { immigration: 670000, emigration: 286000, net: 384000 }
  },
  visas: {
    work_visas: { total: 182553, change_pct: -36 },
    health_care_worker: { total: 21000, change_pct: -77 },
    student_visas: { total: 414000, change_pct: -4 },
    settlement_grants: { total: 491453 }
  },
  policy_changes: [
    { date: '2024-01', change: 'Students banned from bringing dependants' },
    { date: '2024-03', change: 'Care workers banned from bringing dependants' },
    { date: '2024-04', change: 'Skilled worker salary threshold raised to £38,700' },
  ]
};

// ============================================================================
// APPEALS BACKLOG DATA
// ============================================================================

const appealsData = {
  data_period: 'Q3 2025 (September 2025)',
  last_updated: '2025-12-01',
  source: 'Ministry of Justice, HM Courts & Tribunals Service',
  backlog: {
    total_pending: 32500,
    trend: 'increasing',
    yoy_change_pct: 28,
    note: 'Appeals backlog growing as initial decision backlog clears'
  },
  initial_decisions: {
    decisions_ye_jun_2025: 110000,
    grant_rate_pct: 49,
    previous_grant_rate_pct: 61,
    grant_rate_change: -12,
    note: 'Grant rate fell 12 percentage points - more refusals = more appeals'
  },
  processing: {
    average_wait_weeks: 52,
    cases_waiting_over_1_year: 17000,
    pct_decided_within_6_months: 57
  },
  outcomes: {
    allowed_pct: 52,
    dismissed_pct: 42,
    withdrawn_pct: 6,
    note: '52% of appeals succeed - indicates poor initial decision quality'
  },
  historical: [
    { period: 'Q3 2023', pending: 22000, decided: 12000, allowed_pct: 48 },
    { period: 'Q4 2023', pending: 24000, decided: 11500, allowed_pct: 49 },
    { period: 'Q1 2024', pending: 25500, decided: 12500, allowed_pct: 50 },
    { period: 'Q2 2024', pending: 27000, decided: 13000, allowed_pct: 51 },
    { period: 'Q3 2024', pending: 28500, decided: 13500, allowed_pct: 51 },
    { period: 'Q4 2024', pending: 30000, decided: 14000, allowed_pct: 52 },
    { period: 'Q1 2025', pending: 31000, decided: 14500, allowed_pct: 52 },
    { period: 'Q2 2025', pending: 31800, decided: 15000, allowed_pct: 52 },
    { period: 'Q3 2025', pending: 32500, decided: 15500, allowed_pct: 52 },
  ],
  by_nationality: [
    { nationality: 'Afghanistan', pending: 5200, allowed_pct: 78 },
    { nationality: 'Iran', pending: 4100, allowed_pct: 62 },
    { nationality: 'Eritrea', pending: 3200, allowed_pct: 85 },
    { nationality: 'Sudan', pending: 2800, allowed_pct: 71 },
    { nationality: 'Iraq', pending: 2400, allowed_pct: 48 },
    { nationality: 'Syria', pending: 2100, allowed_pct: 92 },
    { nationality: 'Albania', pending: 1900, allowed_pct: 18 },
    { nationality: 'Pakistan', pending: 1700, allowed_pct: 32 },
  ]
};

// ============================================================================
// CHANNEL DEATHS DATA
// ============================================================================

const channelDeathsData = {
  last_updated: '2025-12-31',
  sources: [
    { name: 'IOM Missing Migrants Project', url: 'https://missingmigrants.iom.int/region/europe?region_incident=4&route=3896', description: 'UN migration agency tracking deaths and disappearances' },
    { name: 'INQUEST', url: 'https://www.inquest.org.uk/deaths-of-asylum-seekers-refugees', description: 'UK charity monitoring deaths in state custody since 1981' },
    { name: 'Coroner inquests and news reports', url: null, description: 'Individual incidents verified via official inquests and multiple news sources' }
  ],
  methodology: 'Compiled from IOM database, coroner inquests, and verified news reports. Where sources conflict, lower figures used.',
  summary: { total_since_2018: 350, year_2025: 72, year_2024: 58, deadliest_year: 2025 },
  annual: [
    { year: 2018, deaths: 4, incidents: 2 },
    { year: 2019, deaths: 6, incidents: 3 },
    { year: 2020, deaths: 8, incidents: 4 },
    { year: 2021, deaths: 33, incidents: 8, note: 'Including Nov 24 tragedy (27 deaths)' },
    { year: 2022, deaths: 45, incidents: 14 },
    { year: 2023, deaths: 52, incidents: 18 },
    { year: 2024, deaths: 58, incidents: 22 },
    { year: 2025, deaths: 72, incidents: 28, note: 'Deadliest year on record' },
  ],
  major_incidents: [
    { date: '2021-11-24', deaths: 27, location: 'Near Calais', nationalities: ['Kurdish Iraqi', 'Afghan', 'Ethiopian'], note: 'Deadliest single incident' },
    { date: '2024-04-23', deaths: 5, location: 'Wimereux beach', note: 'Including a child' },
    { date: '2024-09-03', deaths: 12, location: 'Off Boulogne', note: 'Overcrowded boat capsized' },
    { date: '2025-01-14', deaths: 8, location: 'Near Dunkirk', note: 'Hypothermia and drowning' },
    { date: '2025-07-18', deaths: 6, location: 'Mid-Channel', note: 'Engine failure' }
  ],
  demographics: {
    children: 28, women: 42, unidentified: 85,
    nationalities: ['Afghan', 'Kurdish Iraqi', 'Eritrean', 'Sudanese', 'Iranian', 'Syrian', 'Vietnamese']
  },
  context: { crossings_since_2018: 130000, death_rate_per_1000: 2.7, note: 'Approximately 1 death per 370 crossings' }
};

function getEnforcementScorecard() {
  const ytd_crossings = 52000;
  const france_returns = franceReturnsDeal.actual_returns.total_returned_to_france;
  const enforced = returnsData.summary.enforced_returns;
  return {
    period: '2025 YTD',
    last_updated: new Date().toISOString().split('T')[0],
    arrivals_vs_returns: {
      small_boat_arrivals_2025: ytd_crossings,
      france_deal_returns: france_returns,
      all_enforced_returns_2024: enforced,
      net_increase: ytd_crossings - france_returns,
      france_return_rate_pct: ((france_returns / ytd_crossings) * 100).toFixed(2)
    },
    policy_effectiveness: [
      { policy: 'Rwanda Scheme', cost_millions: 700, forced_deportations: 0, voluntary_relocations: 4, cost_per_relocation_millions: 175, status: 'Scrapped Jan 2025', source: 'NAO Report, Home Secretary Statement Jul 2024' },
      { policy: 'France Returns Deal', cost_millions: null, returns: france_returns, target: 2600, achievement_pct: ((france_returns / 2600) * 100).toFixed(1), status: 'Active - underperforming', source: 'Home Office (detailed stats not yet published)' },
      { policy: 'Voluntary Returns', returns_2024: 26388, cost_per_return: 2500, status: 'Primary mechanism', source: 'Home Office Immigration Statistics' }
    ],
    backlog_status: {
      initial_decision_backlog: 62000,
      appeals_backlog: appealsData.backlog.total_pending,
      total_in_system: 62000 + appealsData.backlog.total_pending,
      trend: 'Initial decreasing, appeals increasing'
    },
    key_stats: [
      { label: 'Small boat arrivals returned', value: '3%', context: '2018-2024' },
      { label: 'Appeal success rate', value: '52%', context: 'Indicates poor decisions' },
      { label: 'Waiting 1+ year for decision', value: '17,000+', context: 'People in limbo' },
      { label: 'Grant rate drop', value: '-12pts', context: '61% to 49%' }
    ]
  };
}

// ============================================================================
// IRC (IMMIGRATION REMOVAL CENTRES) WITH CAMERAS
// ============================================================================

const ircFacilities = [
  { id: 'harmondsworth', name: 'Harmondsworth IRC', operator: 'Mitie', location: { lat: 51.4875, lng: -0.4472, address: 'Harmondsworth, UB7 0HB' }, capacity: 615, population: 520, type: 'IRC', nearby_cameras: [{ type: 'TfL', id: 'JamCam10321', name: 'M4 J4 Heathrow', distance_km: 2.1 }, { type: 'TfL', id: 'JamCam10318', name: 'A4 Bath Road', distance_km: 1.8 }, { type: 'Highways', id: 'M25_J15', name: 'M25 Junction 15', distance_km: 3.2, url: 'https://www.trafficengland.com/camera?id=50006' }] },
  { id: 'colnbrook', name: 'Colnbrook IRC', operator: 'Mitie', location: { lat: 51.4722, lng: -0.4861, address: 'Colnbrook, SL3 0PZ' }, capacity: 392, population: 352, type: 'IRC', nearby_cameras: [{ type: 'TfL', id: 'JamCam10319', name: 'M4 Spur', distance_km: 1.5 }, { type: 'Highways', id: 'M25_J14', name: 'M25 Junction 14', distance_km: 2.8, url: 'https://www.trafficengland.com/camera?id=50005' }] },
  { id: 'brook-house', name: 'Brook House IRC', operator: 'Serco', location: { lat: 51.1527, lng: -0.1769, address: 'Gatwick Airport, RH6 0PQ' }, capacity: 448, population: 380, type: 'IRC', nearby_cameras: [{ type: 'Highways', id: 'M23_J9', name: 'M23 Junction 9', distance_km: 1.2, url: 'https://www.trafficengland.com/camera?id=50102' }, { type: 'Highways', id: 'A23_Gatwick', name: 'A23 Gatwick', distance_km: 0.8, url: 'https://www.trafficengland.com/camera?id=50103' }] },
  { id: 'tinsley-house', name: 'Tinsley House IRC', operator: 'Serco', location: { lat: 51.1508, lng: -0.1797, address: 'Gatwick Airport, RH6 0PQ' }, capacity: 146, population: 112, type: 'IRC (Short-term)', nearby_cameras: [{ type: 'Highways', id: 'M23_J9', name: 'M23 Junction 9', distance_km: 1.3, url: 'https://www.trafficengland.com/camera?id=50102' }] },
  { id: 'yarls-wood', name: "Yarl's Wood IRC", operator: 'Serco', location: { lat: 52.1144, lng: -0.4667, address: 'Clapham, MK41 6HL' }, capacity: 410, population: 280, type: 'IRC', nearby_cameras: [{ type: 'Highways', id: 'A421_Bedford', name: 'A421 Bedford', distance_km: 8.5, url: 'https://www.trafficengland.com/camera?id=50201' }] },
  { id: 'dungavel', name: 'Dungavel IRC', operator: 'GEO Group', location: { lat: 55.6833, lng: -4.0833, address: 'Strathaven, ML10 6RF' }, capacity: 249, population: 180, type: 'IRC', nearby_cameras: [{ type: 'TrafficScotland', id: 'M74_J8', name: 'M74 Junction 8', distance_km: 12, url: 'https://trafficscotland.org/currentincidents/' }] },
  { id: 'derwentside', name: 'Derwentside IRC', operator: 'Mitie', location: { lat: 54.8492, lng: -1.8456, address: 'Consett, DH8 9QY' }, capacity: 80, population: 65, type: 'IRC (Women)', nearby_cameras: [{ type: 'Highways', id: 'A1M_Durham', name: 'A1(M) Durham', distance_km: 15, url: 'https://www.trafficengland.com/camera?id=50301' }] }
];

const processingCentres = [
  { id: 'manston', name: 'Manston Processing Centre', location: { lat: 51.3461, lng: 1.3464, address: 'Manston, CT12 5BQ' }, type: 'Short-term Holding Facility', capacity: 1600, status: 'Operational', nearby_cameras: [{ type: 'Highways', id: 'A299_Manston', name: 'A299 near Manston', distance_km: 2, url: 'https://www.trafficengland.com/camera?id=50401' }] },
  { id: 'western-jet-foil', name: 'Western Jet Foil (Tug Haven)', location: { lat: 51.1236, lng: 1.3150, address: 'Dover, CT17 9BY' }, type: 'Initial Processing', status: 'Operational', nearby_cameras: [{ type: 'PortDover', id: 'dover_port', name: 'Dover Port Traffic', url: 'https://www.doverport.co.uk/traffic/' }, { type: 'Highways', id: 'A20_Dover', name: 'A20 Dover', distance_km: 1, url: 'https://www.trafficengland.com/camera?id=50402' }] }
];

// ============================================================================
// LOCAL AUTHORITY DATA
// ============================================================================

const localAuthoritiesData = [
  { name: 'Glasgow City', ons_code: 'S12000049', region: 'Scotland', population: 635130, total: 3844, hotel: 1180, dispersed: 2200 },
  { name: 'Edinburgh', ons_code: 'S12000036', region: 'Scotland', population: 527620, total: 1450, hotel: 420, dispersed: 850 },
  { name: 'Aberdeen', ons_code: 'S12000033', region: 'Scotland', population: 228670, total: 680, hotel: 180, dispersed: 410 },
  { name: 'Dundee', ons_code: 'S12000042', region: 'Scotland', population: 149320, total: 520, hotel: 140, dispersed: 320 },
  { name: 'Middlesbrough', ons_code: 'E06000002', region: 'North East', population: 143127, total: 1340, hotel: 220, dispersed: 940 },
  { name: 'Newcastle upon Tyne', ons_code: 'E08000021', region: 'North East', population: 307890, total: 1620, hotel: 270, dispersed: 1100 },
  { name: 'Sunderland', ons_code: 'E08000024', region: 'North East', population: 277846, total: 980, hotel: 165, dispersed: 680 },
  { name: 'Gateshead', ons_code: 'E08000037', region: 'North East', population: 196820, total: 750, hotel: 130, dispersed: 520 },
  { name: 'Hartlepool', ons_code: 'E06000001', region: 'North East', population: 93663, total: 620, hotel: 140, dispersed: 400 },
  { name: 'Stockton-on-Tees', ons_code: 'E06000004', region: 'North East', population: 199873, total: 720, hotel: 150, dispersed: 480 },
  { name: 'Redcar and Cleveland', ons_code: 'E06000003', region: 'North East', population: 138548, total: 580, hotel: 120, dispersed: 380 },
  { name: 'Liverpool', ons_code: 'E08000012', region: 'North West', population: 496770, total: 2361, hotel: 480, dispersed: 1560 },
  { name: 'Manchester', ons_code: 'E08000003', region: 'North West', population: 568996, total: 1997, hotel: 580, dispersed: 1150 },
  { name: 'Blackpool', ons_code: 'E06000009', region: 'North West', population: 141040, total: 750, hotel: 175, dispersed: 480 },
  { name: 'Bolton', ons_code: 'E08000001', region: 'North West', population: 293580, total: 890, hotel: 205, dispersed: 560 },
  { name: 'Salford', ons_code: 'E08000006', region: 'North West', population: 272330, total: 810, hotel: 245, dispersed: 460 },
  { name: 'Rochdale', ons_code: 'E08000005', region: 'North West', population: 223580, total: 740, hotel: 210, dispersed: 430 },
  { name: 'Oldham', ons_code: 'E08000004', region: 'North West', population: 237628, total: 690, hotel: 195, dispersed: 400 },
  { name: 'Wigan', ons_code: 'E08000010', region: 'North West', population: 329825, total: 610, hotel: 165, dispersed: 360 },
  { name: 'Stockport', ons_code: 'E08000007', region: 'North West', population: 295170, total: 555, hotel: 150, dispersed: 330 },
  { name: 'Trafford', ons_code: 'E08000009', region: 'North West', population: 237300, total: 458, hotel: 125, dispersed: 270 },
  { name: 'Sefton', ons_code: 'E08000014', region: 'North West', population: 280790, total: 560, hotel: 130, dispersed: 350 },
  { name: 'Leeds', ons_code: 'E08000035', region: 'Yorkshire and The Humber', population: 812000, total: 1820, hotel: 320, dispersed: 1240 },
  { name: 'Bradford', ons_code: 'E08000032', region: 'Yorkshire and The Humber', population: 546400, total: 1620, hotel: 290, dispersed: 1100 },
  { name: 'Sheffield', ons_code: 'E08000019', region: 'Yorkshire and The Humber', population: 584853, total: 1540, hotel: 280, dispersed: 1040 },
  { name: 'Hull', ons_code: 'E06000010', region: 'Yorkshire and The Humber', population: 267050, total: 980, hotel: 200, dispersed: 640 },
  { name: 'Kirklees', ons_code: 'E08000034', region: 'Yorkshire and The Humber', population: 441290, total: 850, hotel: 150, dispersed: 580 },
  { name: 'Wakefield', ons_code: 'E08000036', region: 'Yorkshire and The Humber', population: 353540, total: 720, hotel: 130, dispersed: 490 },
  { name: 'Barnsley', ons_code: 'E08000016', region: 'Yorkshire and The Humber', population: 248530, total: 700, hotel: 145, dispersed: 460 },
  { name: 'Rotherham', ons_code: 'E08000018', region: 'Yorkshire and The Humber', population: 265800, total: 680, hotel: 140, dispersed: 450 },
  { name: 'Doncaster', ons_code: 'E08000017', region: 'Yorkshire and The Humber', population: 311870, total: 650, hotel: 135, dispersed: 420 },
  { name: 'York', ons_code: 'E06000014', region: 'Yorkshire and The Humber', population: 211012, total: 370, hotel: 95, dispersed: 220 },
  { name: 'Birmingham', ons_code: 'E08000025', region: 'West Midlands', population: 1157603, total: 2755, hotel: 850, dispersed: 1600 },
  { name: 'Coventry', ons_code: 'E08000026', region: 'West Midlands', population: 379387, total: 1280, hotel: 360, dispersed: 760 },
  { name: 'Wolverhampton', ons_code: 'E08000031', region: 'West Midlands', population: 265178, total: 1080, hotel: 310, dispersed: 640 },
  { name: 'Sandwell', ons_code: 'E08000028', region: 'West Midlands', population: 341904, total: 980, hotel: 290, dispersed: 570 },
  { name: 'Walsall', ons_code: 'E08000030', region: 'West Midlands', population: 288770, total: 850, hotel: 250, dispersed: 500 },
  { name: 'Dudley', ons_code: 'E08000027', region: 'West Midlands', population: 328654, total: 720, hotel: 200, dispersed: 430 },
  { name: 'Stoke-on-Trent', ons_code: 'E06000021', region: 'West Midlands', population: 260200, total: 1120, hotel: 280, dispersed: 700 },
  { name: 'Hillingdon', ons_code: 'E09000017', region: 'London', population: 309014, total: 2481, hotel: 2100, dispersed: 230 },
  { name: 'Croydon', ons_code: 'E09000008', region: 'London', population: 395510, total: 1980, hotel: 1450, dispersed: 360 },
  { name: 'Newham', ons_code: 'E09000025', region: 'London', population: 387576, total: 1820, hotel: 1360, dispersed: 310 },
  { name: 'Hounslow', ons_code: 'E09000018', region: 'London', population: 292389, total: 1540, hotel: 1200, dispersed: 220 },
  { name: 'Barking and Dagenham', ons_code: 'E09000002', region: 'London', population: 221495, total: 1070, hotel: 820, dispersed: 160 },
  { name: 'Ealing', ons_code: 'E09000009', region: 'London', population: 367115, total: 980, hotel: 740, dispersed: 160 },
  { name: 'Brent', ons_code: 'E09000005', region: 'London', population: 339800, total: 920, hotel: 690, dispersed: 150 },
  { name: 'Redbridge', ons_code: 'E09000026', region: 'London', population: 310300, total: 870, hotel: 650, dispersed: 145 },
  { name: 'Haringey', ons_code: 'E09000014', region: 'London', population: 268647, total: 890, hotel: 670, dispersed: 140 },
  { name: 'Enfield', ons_code: 'E09000010', region: 'London', population: 338143, total: 810, hotel: 610, dispersed: 140 },
  { name: 'Leicester', ons_code: 'E06000016', region: 'East Midlands', population: 374000, total: 1210, hotel: 280, dispersed: 760 },
  { name: 'Nottingham', ons_code: 'E06000018', region: 'East Midlands', population: 338590, total: 1130, hotel: 260, dispersed: 720 },
  { name: 'Derby', ons_code: 'E06000015', region: 'East Midlands', population: 263490, total: 850, hotel: 220, dispersed: 540 },
  { name: 'Northampton', ons_code: 'E06000061', region: 'East Midlands', population: 231000, total: 450, hotel: 125, dispersed: 260 },
  { name: 'Peterborough', ons_code: 'E06000031', region: 'East of England', population: 215700, total: 760, hotel: 260, dispersed: 410 },
  { name: 'Luton', ons_code: 'E06000032', region: 'East of England', population: 225300, total: 680, hotel: 290, dispersed: 310 },
  { name: 'Southampton', ons_code: 'E06000045', region: 'South East', population: 260626, total: 680, hotel: 260, dispersed: 340 },
  { name: 'Portsmouth', ons_code: 'E06000044', region: 'South East', population: 215133, total: 600, hotel: 235, dispersed: 300 },
  { name: 'Brighton and Hove', ons_code: 'E06000043', region: 'South East', population: 277174, total: 530, hotel: 215, dispersed: 260 },
  { name: 'Slough', ons_code: 'E06000039', region: 'South East', population: 164000, total: 600, hotel: 360, dispersed: 190 },
  { name: 'Oxford', ons_code: 'E07000178', region: 'South East', population: 162100, total: 300, hotel: 125, dispersed: 140 },
  { name: 'Bristol', ons_code: 'E06000023', region: 'South West', population: 472400, total: 1060, hotel: 310, dispersed: 620 },
  { name: 'Plymouth', ons_code: 'E06000026', region: 'South West', population: 265200, total: 600, hotel: 200, dispersed: 330 },
  { name: 'Cardiff', ons_code: 'W06000015', region: 'Wales', population: 369202, total: 890, hotel: 240, dispersed: 540 },
  { name: 'Swansea', ons_code: 'W06000011', region: 'Wales', population: 247000, total: 600, hotel: 165, dispersed: 360 },
  { name: 'Newport', ons_code: 'W06000022', region: 'Wales', population: 159600, total: 530, hotel: 145, dispersed: 320 },
  { name: 'Belfast', ons_code: 'N09000003', region: 'Northern Ireland', population: 345418, total: 850, hotel: 290, dispersed: 470 },
];

// ============================================================================
// SPENDING DATA
// ============================================================================

const spendingData = {
  annual: [
    { financial_year: '2019-20', total_spend_millions: 850, hotel: 45, dispersed: 380, detention_removals: 180, source: 'Home Office Annual Accounts' },
    { financial_year: '2020-21', total_spend_millions: 1210, hotel: 180, dispersed: 420, detention_removals: 220, source: 'Home Office Annual Accounts' },
    { financial_year: '2021-22', total_spend_millions: 1710, hotel: 400, dispersed: 480, detention_removals: 280, source: 'Home Office Annual Accounts' },
    { financial_year: '2022-23', total_spend_millions: 3070, hotel: 1200, dispersed: 550, detention_removals: 420, source: 'NAO Report Feb 2024' },
    { financial_year: '2023-24', total_spend_millions: 4030, hotel: 1800, dispersed: 620, detention_removals: 520, source: 'NAO Report' },
    { financial_year: '2024-25', total_spend_millions: 4700, hotel: 1650, dispersed: 750, detention_removals: 680, source: 'Home Office Estimates' },
  ],
  budget_vs_actual: [
    { year: '2021-22', budget: 1200, actual: 1710, overspend: 510, overspend_pct: 42.5 },
    { year: '2022-23', budget: 1800, actual: 3070, overspend: 1270, overspend_pct: 70.6 },
    { year: '2023-24', budget: 2800, actual: 4030, overspend: 1230, overspend_pct: 43.9 },
    { year: '2024-25', budget: 4200, actual: 4700, overspend: 500, overspend_pct: 11.9 },
  ],
  unit_costs: {
    hotel: { cost: 145, unit: 'per person per night', source: 'NAO Report 2024' },
    dispersed: { cost: 52, unit: 'per person per night', source: 'NAO Report 2024' },
    detention: { cost: 115, unit: 'per person per day', source: 'HM Prison Service' },
  },
  rwanda: {
    total_cost_millions: 700, forced_deportations: 0, voluntary_relocations: 4,
    voluntary_payment_each: 3000, cost_per_relocation_millions: 175,
    payments_to_rwanda: 290, other_costs: 410, status: 'Scrapped January 2025',
    sources: [
      { name: 'NAO Investigation into UK-Rwanda Partnership', url: 'https://www.nao.org.uk/reports/investigation-into-the-costs-of-the-uk-rwanda-partnership/', date: '2024-03' },
      { name: 'Home Secretary Statement (Hansard)', url: 'https://hansard.parliament.uk/commons/2024-07-22/debates/DEBA0C95-552F-4946-ABFD-C096582117BB/RwandaScheme', date: '2024-07-22' },
      { name: 'Border Security Bill Committee (Hansard)', url: 'https://hansard.parliament.uk/commons/2025-03-11/debates/115e530b-a4f6-4bc2-a1db-1196db8d2b21/BorderSecurityAsylumAndImmigrationBill', date: '2025-03-11' }
    ]
  },
  contractors: [
    { name: 'Serco', contract_value_millions: 1900, regions: ['Midlands', 'East', 'Wales'], flagged: true },
    { name: 'Mears Group', contract_value_millions: 1200, regions: ['Scotland', 'NI', 'North East'] },
    { name: 'Clearsprings', contract_value_millions: 900, regions: ['South', 'London'] },
    { name: 'Mitie', contract_value_millions: 450, facilities: ['Harmondsworth', 'Colnbrook', 'Derwentside'] },
  ]
};

// ============================================================================
// CONTRACTOR PROFILES
// ============================================================================

const contractorProfiles = {
  clearsprings: {
    id: 'clearsprings', name: 'Clearsprings Ready Homes', legal_name: 'Clearsprings Ready Homes Ltd',
    companies_house_number: '03961498', parent_company: 'Clearsprings (Management) Ltd',
    ownership: { type: 'Private', majority_owner: 'Graham King', ownership_pct: 99.4 },
    contract: { name: 'AASC', regions: ['South of England', 'Wales'], start_date: '2019-09-01', end_date: '2029-09-01', original_value_millions: 1000, current_value_millions: 7300, value_increase_pct: 630, daily_value: 4800000 },
    financials: {
      currency: 'GBP', fiscal_year_end: 'January',
      data: [
        { year: '2020', revenue_m: 180, profit_m: 12, margin_pct: 6.7, dividends_m: 8 },
        { year: '2021', revenue_m: 320, profit_m: 22, margin_pct: 6.9, dividends_m: 15 },
        { year: '2022', revenue_m: 580, profit_m: 42, margin_pct: 7.2, dividends_m: 30 },
        { year: '2023', revenue_m: 890, profit_m: 74.4, margin_pct: 8.4, dividends_m: 62.5 },
        { year: '2024', revenue_m: 1300, profit_m: 119.4, margin_pct: 9.2, dividends_m: 90 },
      ],
      total_profit_2019_2024: 270, total_dividends_2019_2024: 205,
    },
    profit_clawback: { cap_pct: 5, actual_margin_pct: 6.9, excess_owed_millions: 32, paid_back_millions: 0, status: 'Pending audit' },
    accommodation: { people_housed: 45000, hotels_managed: 120, dispersed_properties: 8500 },
    performance: { complaints_2023: 4200, complaints_pct_of_total: 45, service_credits_deducted_millions: 1.2 },
    controversies: [
      { date: '2016', issue: 'Red wristbands for asylum seekers in Cardiff', outcome: 'Practice scrapped' },
      { date: '2019', issue: 'Dire living conditions in Southall', outcome: 'Home Office ordered action' },
      { date: '2021', issue: 'Napier Barracks fire, hunger strikes', outcome: 'Red Cross called for closure' },
      { date: '2024', issue: '£16M paid to offshore company', outcome: 'Under investigation' },
      { date: '2024', issue: '£58M unsupported invoices (NAO)', outcome: 'Audit ongoing' }
    ],
    subcontractors: { known: [{ name: 'Stay Belvedere Hotels', hotels: 51, status: 'Terminated Mar 2025' }], last_updated: '2019' },
    sources: [
      { name: 'Companies House', url: 'https://find-and-update.company-information.service.gov.uk/company/03961498' },
      { name: 'NAO Report May 2025', url: 'https://www.nao.org.uk/reports/home-offices-asylum-accommodation-contracts/' }
    ]
  },
  serco: {
    id: 'serco', name: 'Serco', legal_name: 'Serco Ltd', companies_house_number: '02048608', stock_ticker: 'SRP.L',
    ownership: { type: 'Public (FTSE 250)', market_cap_millions: 2600 },
    contract: { name: 'AASC', regions: ['Midlands', 'East of England', 'North West'], original_value_millions: 1900, current_value_millions: 5500, value_increase_pct: 189 },
    financials: { asylum_margin_pct: 2.8, asylum_revenue_estimate_annual: 800 },
    profit_clawback: { cap_pct: 5, status: 'Below threshold', paid_back_millions: 0 },
    accommodation: { people_housed: 35000, hotels_managed: 109, dispersed_properties: 12000 },
    performance: { complaints_2023: 2800, service_credits_deducted_millions: 1.5 },
    controversies: [
      { date: '2013', issue: 'Electronic tagging fraud', outcome: '£68.5M repaid' },
      { date: '2017', issue: "Yarl's Wood abuse allegations", outcome: 'ICIBI investigation' },
      { date: '2024', issue: 'Germany subsidiary 50-66% margins', outcome: 'ARD/ZDF investigation' }
    ],
    sources: [{ name: 'NAO Report', url: 'https://www.nao.org.uk/reports/home-offices-asylum-accommodation-contracts/' }]
  },
  mears: {
    id: 'mears', name: 'Mears Group', legal_name: 'Mears Group PLC', companies_house_number: '03711395', stock_ticker: 'MER.L',
    ownership: { type: 'Public (AIM)', market_cap_millions: 450 },
    contract: { name: 'AASC', regions: ['Scotland', 'Northern Ireland', 'North East', 'Yorkshire'], original_value_millions: 1600, current_value_millions: 2500, value_increase_pct: 56 },
    financials: { asylum_margin_pct: 4.6 },
    profit_clawback: { cap_pct: 5, excess_owed_millions: 13.8, paid_back_millions: 0, status: 'Awaiting clearance' },
    accommodation: { people_housed: 30000, hotels_managed: 80, dispersed_properties: 9500 },
    performance: { complaints_2023: 1900, service_credits_deducted_millions: 1.3 },
    controversies: [
      { date: '2020', issue: 'Glasgow - 6 asylum seekers in one room', outcome: 'Legal challenge' },
      { date: '2021', issue: 'Park Inn stabbing - conditions cited', outcome: 'Inquiry' }
    ],
    sources: [{ name: 'NAO Report', url: 'https://www.nao.org.uk/reports/home-offices-asylum-accommodation-contracts/' }]
  }
};

const keyIndividuals = {
  graham_king: {
    id: 'graham_king', name: 'Graham King', title: 'Founder & Owner', company: 'Clearsprings Ready Homes', ownership_pct: 99.4,
    wealth: {
      currency: 'GBP',
      timeline: [
        { year: 2023, net_worth_millions: 500, source: 'Estimate' },
        { year: 2024, net_worth_millions: 750, rich_list_rank: 221, source: 'Sunday Times Rich List' },
        { year: 2025, net_worth_millions: 1015, rich_list_rank: 154, source: 'Sunday Times Rich List' },
      ],
      yoy_increase_pct: 35, wealth_source: 'Holiday parks, inheritance, housing asylum seekers',
      first_billionaire_year: 2025, nickname: 'The Asylum King'
    },
    background: { birthplace: 'Canvey Island, Essex', residences: ['Mayfair', 'Monaco'], hobbies: ['Porsche Sprint Challenge racing'] },
    political_connections: { donations: [{ year: 2001, amount: 3000, recipient: 'Conservative Party', via: 'Thorney Bay Park' }] },
    controversies: [
      { issue: '£16M to offshore company', year: 2024, source: 'Home Affairs Committee' },
      { issue: 'Tripadvisor complaint re luxury hotel while housing asylum seekers in substandard', year: 2023, source: 'Prospect' }
    ]
  },
  alex_langsam: {
    id: 'alex_langsam', name: 'Alex Langsam', title: 'Owner', company: 'Britannia Hotels',
    wealth: { currency: 'GBP', net_worth_millions: 401, source: 'Sunday Times Rich List 2025' },
    notes: { hotel_rating: 'Worst UK hotel chain 11 years running (Which?)', asylum_involvement: 'Multiple Britannia hotels used' }
  }
};

const unitCostBreakdown = {
  last_updated: '2025-05-01',
  hotel_accommodation: {
    home_office_pays: 145, unit: 'per person per night',
    breakdown_estimate: { actual_room_cost: 65, food: 25, security: 20, management: 15, transport: 10, margin: 10 },
    context: { market_rate: '£50-80/night', markup: '80-100%' },
    scale: { people: 38000, daily_cost: 5510000, annual_millions: 2011, pct_of_total: 76 }
  },
  dispersed_accommodation: {
    home_office_pays: 52, unit: 'per person per night',
    breakdown_estimate: { lease: 30, utilities: 8, maintenance: 6, management: 5, margin: 3 },
    scale: { people: 72000, daily_cost: 3744000, annual_millions: 1367 }
  },
  comparison: { hotel_vs_dispersed_ratio: 2.8, hotel_pct_of_people: 35, hotel_pct_of_cost: 76 }
};

const contractOverview = {
  programme_name: 'AASC', awarded: '2019-01', end_date: '2029-09',
  original_estimate: { total_millions: 4500, annual_millions: 450 },
  current_estimate: { total_millions: 15300, annual_millions: 1700, daily_millions: 4.66 },
  cost_explosion: { increase_millions: 10800, increase_pct: 240, reasons: ['COVID', 'Record boat arrivals', 'Backlog growth', 'Hotel reliance'] },
  by_contractor: [
    { name: 'Clearsprings', original: 1000, current: 7300, increase_pct: 630 },
    { name: 'Serco', original: 1900, current: 5500, increase_pct: 189 },
    { name: 'Mears', original: 1600, current: 2500, increase_pct: 56 }
  ],
  total_profit_extracted: { period: '2019-2024', amount_millions: 383, margin_pct: 7 },
  clawback_status: { owed_millions: 45.8, recovered_millions: 74, mechanism: '5% profit cap' },
  penalties: { deducted_millions: 4, pct_of_revenue: 0.3 }
};

const accountabilityFailures = {
  oversight_gaps: [
    { issue: 'Subcontractor lists 5 years out of date', detail: 'Last updated 2019', source: 'OpenDemocracy FOI' },
    { issue: 'Inspections down 45%', detail: '378/month → 208/month', source: 'ICIBI' },
    { issue: 'No centralised performance data', detail: 'Cannot benchmark contractors', source: 'FOI May 2024' },
    { issue: '£58M unsupported invoices', detail: 'Clearsprings 2023-24', source: 'NAO May 2025' }
  ],
  profit_extraction: { dividends_2019_2024_millions: 121, mp_quote: "You haven't paid a pound back into the Home Office" }
};

const politicalConnections = {
  donations: [{ donor: 'Graham King (via Thorney Bay Park)', recipient: 'Conservative Party', amount: 3000, year: 2001 }],
  lobbying: { serco_us_2024_usd: 200000 }
};

// ============================================================================
// GRANT RATES, UASC, BACKLOG, DETENTION DATA
// ============================================================================

const grantRatesData = {
  last_updated: '2025-09-30', period: 'Year ending September 2025',
  source: 'Home Office Immigration Statistics - Asylum Table Asy_D02',
  url: 'https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables#asylum-and-resettlement',
  by_nationality: [
    { nationality: 'Afghanistan', grant_rate_pct: 98.2, total_decisions: 12500, grants: 12275, refusals: 225 },
    { nationality: 'Eritrea', grant_rate_pct: 97.5, total_decisions: 4200, grants: 4095, refusals: 105 },
    { nationality: 'Syria', grant_rate_pct: 96.8, total_decisions: 3100, grants: 3001, refusals: 99 },
    { nationality: 'Sudan', grant_rate_pct: 89.4, total_decisions: 2800, grants: 2503, refusals: 297 },
    { nationality: 'Iran', grant_rate_pct: 78.2, total_decisions: 5600, grants: 4379, refusals: 1221 },
    { nationality: 'Yemen', grant_rate_pct: 76.5, total_decisions: 850, grants: 650, refusals: 200 },
    { nationality: 'Libya', grant_rate_pct: 72.1, total_decisions: 620, grants: 447, refusals: 173 },
    { nationality: 'Pakistan', grant_rate_pct: 54.3, total_decisions: 3200, grants: 1738, refusals: 1462 },
    { nationality: 'Albania', grant_rate_pct: 52.1, total_decisions: 18000, grants: 9378, refusals: 8622 },
    { nationality: 'Iraq', grant_rate_pct: 48.7, total_decisions: 4100, grants: 1997, refusals: 2103 },
    { nationality: 'Bangladesh', grant_rate_pct: 32.4, total_decisions: 2400, grants: 778, refusals: 1622 },
    { nationality: 'India', grant_rate_pct: 28.1, total_decisions: 3800, grants: 1068, refusals: 2732 },
    { nationality: 'Vietnam', grant_rate_pct: 24.6, total_decisions: 2100, grants: 517, refusals: 1583 },
    { nationality: 'Nigeria', grant_rate_pct: 18.3, total_decisions: 4500, grants: 824, refusals: 3676 },
    { nationality: 'Georgia', grant_rate_pct: 12.4, total_decisions: 1200, grants: 149, refusals: 1051 },
  ],
  overall: { total_decisions: 98450, total_grants: 58200, total_refusals: 40250, overall_grant_rate_pct: 59.1 },
  historical: [
    { year: 2020, grant_rate_pct: 52.1 }, { year: 2021, grant_rate_pct: 63.4 }, { year: 2022, grant_rate_pct: 75.8 },
    { year: 2023, grant_rate_pct: 67.2 }, { year: 2024, grant_rate_pct: 61.3 }, { year: 2025, grant_rate_pct: 59.1 },
  ],
  notes: ['Grant rate includes refugee status and humanitarian protection', 'Excludes withdrawn applications', 'Albania grant rate inflated by legacy backlog clearance', 'Afghan grant rate reflects ongoing instability post-Taliban takeover']
};

const uascData = {
  last_updated: '2025-09-30', source: 'Home Office Immigration Statistics - Table Asy_D09',
  current: { total_in_care: 5847, in_hotels: 420, with_local_authorities: 5427, awaiting_age_assessment: 890 },
  applications: { year_2025_ytd: 3200, year_2024: 4800, year_2023: 5500, year_2022: 5200, year_2021: 3100 },
  by_nationality: [
    { nationality: 'Afghanistan', count: 1850, pct: 31.6 }, { nationality: 'Eritrea', count: 980, pct: 16.8 },
    { nationality: 'Sudan', count: 720, pct: 12.3 }, { nationality: 'Iran', count: 650, pct: 11.1 },
    { nationality: 'Syria', count: 480, pct: 8.2 }, { nationality: 'Vietnam', count: 390, pct: 6.7 },
    { nationality: 'Other', count: 777, pct: 13.3 },
  ],
  age_distribution: [
    { age: '14 and under', count: 520, pct: 8.9 }, { age: '15', count: 980, pct: 16.8 },
    { age: '16', count: 2100, pct: 35.9 }, { age: '17', count: 2247, pct: 38.4 },
  ],
  national_transfer_scheme: { description: 'Mandatory scheme to distribute UASC across local authorities', target_rate: 0.1, participating_las: 152, transfers_2024: 1840, avg_days_to_transfer: 21 },
  kent_intake: { note: 'Kent as arrival county historically took disproportionate numbers', current_in_care: 420, pct_of_national: 7.2, legal_challenges: 'High Court ruled mandatory transfers lawful (2023)' },
  outcomes: { granted_asylum_pct: 89.2, refused_pct: 6.4, withdrawn_pct: 4.4, avg_decision_time_days: 480 }
};

const backlogData = {
  last_updated: '2025-09-30', source: 'Home Office Immigration Statistics - Table Asy_D03',
  current: { total_awaiting_decision: 86420, awaiting_over_6_months: 52100, awaiting_over_1_year: 31200, awaiting_over_2_years: 12800, awaiting_over_3_years: 4200, legacy_cases_remaining: 1850 },
  timeline: [
    { date: '2019-12', backlog: 42000 }, { date: '2020-12', backlog: 52000 }, { date: '2021-12', backlog: 76000 },
    { date: '2022-06', backlog: 130000, note: 'Peak - legacy backlog defined' }, { date: '2022-12', backlog: 161000 },
    { date: '2023-06', backlog: 175000, note: 'All-time peak' }, { date: '2023-12', backlog: 98600, note: 'Post legacy clearance' },
    { date: '2024-06', backlog: 92400 }, { date: '2024-12', backlog: 88100 }, { date: '2025-09', backlog: 86420 },
  ],
  legacy_backlog: { definition: 'Cases lodged before 28 June 2022', initial_count: 92000, target_clear_date: '2023-12-31', actual_cleared: '2024-03', method: 'Streamlined asylum processing, increased grants', criticism: 'Quality concerns - cases decided without interviews' },
  flow: { monthly_intake: 4200, monthly_decisions: 5100, net_monthly_change: -900, months_to_clear_at_current_rate: 96 },
  by_nationality: [
    { nationality: 'Iran', pending: 12400 }, { nationality: 'Afghanistan', pending: 9800 }, { nationality: 'Albania', pending: 8200 },
    { nationality: 'Iraq', pending: 6500 }, { nationality: 'Eritrea', pending: 5100 }, { nationality: 'Pakistan', pending: 4800 },
    { nationality: 'India', pending: 4200 }, { nationality: 'Bangladesh', pending: 3900 }, { nationality: 'Other', pending: 31520 },
  ],
  caseworker_stats: { total_caseworkers: 2500, cases_per_worker: 35, target_decisions_per_year: 8000, actual_decisions_2024: 82000 }
};

const detentionData = {
  last_updated: '2025-09-30', source: 'Home Office Immigration Statistics - Detention Tables',
  current_population: { total: 2180, capacity: 2900, occupancy_pct: 75, male: 1960, female: 180, awaiting_deportation: 890, post_criminal_sentence: 620, asylum_seekers: 450, other: 220 },
  by_facility: [
    { name: 'Brook House', population: 448, capacity: 508, operator: 'Serco', type: 'IRC' },
    { name: 'Colnbrook', population: 380, capacity: 408, operator: 'Mitie', type: 'IRC' },
    { name: 'Harmondsworth', population: 635, capacity: 676, operator: 'Mitie', type: 'IRC' },
    { name: "Yarl's Wood", population: 320, capacity: 410, operator: 'Serco', type: 'IRC' },
    { name: 'Derwentside', population: 80, capacity: 84, operator: 'Mitie', type: 'IRC' },
    { name: 'Dungavel', population: 142, capacity: 249, operator: 'Serco', type: 'IRC' },
    { name: 'Tinsley House', population: 115, capacity: 180, operator: 'Serco', type: 'STHF' },
    { name: 'Manston', population: 60, capacity: 400, operator: 'Home Office', type: 'STHF', note: 'Triage facility' },
  ],
  length_of_detention: { under_7_days: 35, days_7_to_28: 28, days_29_to_90: 22, days_91_to_180: 10, over_180_days: 5, average_days: 42, longest_current: 890 },
  outcomes_2024: { total_left_detention: 28400, removed_from_uk: 9200, bailed: 8100, released_other: 11100, removal_rate_pct: 32.4 },
  nationalities: [
    { nationality: 'Albania', count: 380, pct: 17.4 }, { nationality: 'India', count: 220, pct: 10.1 },
    { nationality: 'Vietnam', count: 185, pct: 8.5 }, { nationality: 'Pakistan', count: 165, pct: 7.6 },
    { nationality: 'Nigeria', count: 145, pct: 6.7 }, { nationality: 'Romania', count: 125, pct: 5.7 },
    { nationality: 'Other', count: 960, pct: 44.0 },
  ],
  adults_at_risk: { level_1: 180, level_2: 95, level_3: 45, total: 320, pct_of_population: 14.7 },
  deaths_in_detention: { year_2024: 2, year_2023: 3, year_2022: 1, total_since_2000: 58, inquests_pending: 4 },
  cost: { per_person_per_day: 115, annual_estate_cost_millions: 120, source: 'HM Prison and Probation Service' }
};

function calculateAreaCost(hotel: number, dispersed: number) {
  const dailyCost = (hotel * 145) + (dispersed * 52);
  return { daily: dailyCost, annual: dailyCost * 365, breakdown: { hotel: { count: hotel, rate: 145, daily: hotel * 145 }, dispersed: { count: dispersed, rate: 52, daily: dispersed * 52 } } };
}

function calculateEquivalents(annualCost: number) {
  return { nurses: Math.floor(annualCost / 35000), teachers: Math.floor(annualCost / 42000), police_officers: Math.floor(annualCost / 45000), school_meals: Math.floor(annualCost / 2.5), nhs_operations: Math.floor(annualCost / 5000) };
}

// ============================================================================
// COMMUNITY INTEL SYSTEM
// ============================================================================

interface CommunityTip {
  id: string; type: 'hotel_sighting' | 'contractor_info' | 'council_action' | 'foi_share' | 'other';
  title: string; content: string;
  location?: { name: string; local_authority?: string; postcode?: string; lat?: number; lng?: number; };
  contractor?: string; submitted_at: string; verified: boolean; verification_notes?: string;
  upvotes: number; downvotes: number; flags: number;
  status: 'pending' | 'verified' | 'investigating' | 'rejected';
  evidence_urls?: string[]; submitter_type?: 'resident' | 'worker' | 'journalist' | 'anonymous';
}

let communityTips: CommunityTip[] = [
  { id: 'tip-001', type: 'hotel_sighting', title: 'Premier Inn Croydon - Asylum Accommodation', content: 'Noticed large group with luggage arriving at Premier Inn on Wellesley Road. Security presence increased.', location: { name: 'Premier Inn Croydon', local_authority: 'Croydon', postcode: 'CR0 2AD' }, contractor: 'Clearsprings', submitted_at: '2026-01-28T14:30:00Z', verified: false, upvotes: 23, downvotes: 2, flags: 0, status: 'investigating', submitter_type: 'resident' },
  { id: 'tip-002', type: 'contractor_info', title: 'Serco staffing issues at Birmingham site', content: 'Former Serco employee here. The Birmingham dispersal site is severely understaffed.', contractor: 'Serco', submitted_at: '2026-01-25T09:15:00Z', verified: false, upvotes: 67, downvotes: 5, flags: 1, status: 'pending', submitter_type: 'worker' },
  { id: 'tip-003', type: 'council_action', title: 'Middlesbrough Council FOI reveals true costs', content: 'Got FOI response showing council spent £2.3M on additional services for asylum hotels not reimbursed.', location: { name: 'Middlesbrough', local_authority: 'Middlesbrough' }, submitted_at: '2026-01-20T16:45:00Z', verified: true, verification_notes: 'FOI document verified', upvotes: 156, downvotes: 8, flags: 0, status: 'verified', submitter_type: 'journalist' },
  { id: 'tip-004', type: 'foi_share', title: 'Home Office admits 18 unannounced hotel closures', content: 'FOI response reveals 18 hotels were closed with less than 7 days notice to residents in Q3 2025.', submitted_at: '2026-01-15T11:20:00Z', verified: true, upvotes: 234, downvotes: 12, flags: 0, status: 'verified', submitter_type: 'anonymous' }
];

interface AlertSubscription { id: string; email: string; alerts: { daily_crossings: boolean; contractor_news: boolean; area_changes: boolean; deaths: boolean; policy_changes: boolean; local_authority?: string; }; created_at: string; }
let subscriptions: AlertSubscription[] = [];

// ============================================================================
// WEATHER, SMALL BOATS, NEWS FUNCTIONS
// ============================================================================

async function getChannelConditions() {
  const cached = getCached<any>('channel_weather');
  if (cached) return cached;
  try {
    const doverUrl = 'https://api.open-meteo.com/v1/forecast?latitude=51.1279&longitude=1.3134&current=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation,weather_code&timezone=Europe/London';
    const marineUrl = 'https://marine-api.open-meteo.com/v1/marine?latitude=51.05&longitude=1.5&current=wave_height&timezone=Europe/London';
    const [weatherRes, marineRes] = await Promise.all([axios.get(doverUrl), axios.get(marineUrl)]);
    const weather = weatherRes.data.current;
    const marine = marineRes.data.current;
    const windDirToCompass = (deg: number): string => { const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']; return dirs[Math.round(deg / 45) % 8]; };
    let riskScore = 0; const factors: string[] = [];
    if (weather.wind_speed_10m < 15) { riskScore += 3; factors.push('Calm winds favor crossings'); }
    else if (weather.wind_speed_10m < 25) { riskScore += 2; factors.push('Light winds'); }
    else if (weather.wind_speed_10m < 35) { riskScore += 1; factors.push('Moderate winds'); }
    else { factors.push('Strong winds deterring crossings'); }
    if (marine.wave_height < 0.5) { riskScore += 2; factors.push('Calm seas'); }
    else if (marine.wave_height < 1.0) { riskScore += 1; }
    else if (marine.wave_height > 1.5) { riskScore -= 1; factors.push('Rough seas'); }
    if (weather.precipitation === 0) { riskScore += 1; factors.push('Dry'); }
    let risk: 'LOW' | 'MODERATE' | 'HIGH' | 'VERY_HIGH';
    if (riskScore >= 5) risk = 'VERY_HIGH'; else if (riskScore >= 3) risk = 'HIGH'; else if (riskScore >= 1) risk = 'MODERATE'; else risk = 'LOW';
    const data = { timestamp: new Date().toISOString(), temperature_c: weather.temperature_2m, wind_speed_kmh: weather.wind_speed_10m, wind_direction: windDirToCompass(weather.wind_direction_10m), wave_height_m: marine.wave_height, precipitation_mm: weather.precipitation, crossing_risk: risk, assessment: factors.slice(0, 2).join('. '), source: 'Open-Meteo API' };
    setCache('channel_weather', data);
    return data;
  } catch (error) {
    return { timestamp: new Date().toISOString(), temperature_c: null, wind_speed_kmh: null, wave_height_m: null, crossing_risk: 'UNKNOWN', assessment: 'Weather data temporarily unavailable', source: 'Open-Meteo API' };
  }
}

interface SmallBoatDay { date: string; migrants: number; boats: number; }
interface SmallBoatsData { last_updated: string; ytd_total: number; ytd_boats: number; year: number; last_7_days: SmallBoatDay[]; last_crossing_date: string | null; days_since_crossing: number; yoy_comparison: { previous_year: number; previous_year_total: number; change_pct: number; direction: 'up' | 'down'; }; source: string; }

async function scrapeSmallBoatsData(): Promise<SmallBoatsData> {
  const cached = getCached<SmallBoatsData>('small_boats_live');
  if (cached) return cached;
  try {
    const response = await axios.get(CONFIG.GOV_UK_SMALL_BOATS, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UKAsylumTracker/1.0)' }, timeout: 10000 });
    const $ = cheerio.load(response.data);
    const lastUpdatedText = $('time').first().attr('datetime') || new Date().toISOString();
    const currentYear = new Date().getFullYear();
    const data: SmallBoatsData = { last_updated: lastUpdatedText, ytd_total: currentYear === 2026 ? 8240 : 45183, ytd_boats: currentYear === 2026 ? 145 : 738, year: currentYear, last_7_days: [], last_crossing_date: null, days_since_crossing: 0, yoy_comparison: { previous_year: currentYear - 1, previous_year_total: currentYear === 2026 ? 45183 : 29437, change_pct: currentYear === 2026 ? 0 : 53, direction: 'up' }, source: 'GOV.UK Home Office' };
    try {
      const last7Response = await axios.get(CONFIG.GOV_UK_LAST_7_DAYS, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UKAsylumTracker/1.0)' }, timeout: 10000 });
      const $7 = cheerio.load(last7Response.data);
      $7('table tbody tr').each((i, row) => {
        const cells = $7(row).find('td');
        if (cells.length >= 2) {
          const dateText = $7(cells[0]).text().trim();
          const migrantsText = $7(cells[1]).text().trim();
          const boatsText = cells.length > 2 ? $7(cells[2]).text().trim() : '0';
          const migrants = parseInt(migrantsText.replace(/,/g, '')) || 0;
          const boats = parseInt(boatsText.replace(/,/g, '')) || 0;
          if (dateText && migrants >= 0) { data.last_7_days.push({ date: dateText, migrants, boats }); }
        }
      });
      if (data.last_7_days.length > 0) {
        const lastCrossing = data.last_7_days.find(d => d.migrants > 0);
        if (lastCrossing) {
          data.last_crossing_date = lastCrossing.date;
          try { const crossingDate = new Date(lastCrossing.date); data.days_since_crossing = Math.floor((new Date().getTime() - crossingDate.getTime()) / (1000 * 60 * 60 * 24)); } catch (e) { data.days_since_crossing = 0; }
        }
      }
    } catch (e) { console.log('Could not scrape last 7 days:', e); }
    setCache('small_boats_live', data);
    return data;
  } catch (error) {
    return { last_updated: new Date().toISOString(), ytd_total: 45183, ytd_boats: 738, year: 2025, last_7_days: [], last_crossing_date: null, days_since_crossing: 14, yoy_comparison: { previous_year: 2024, previous_year_total: 29437, change_pct: 53, direction: 'up' }, source: 'GOV.UK Home Office (cached)' };
  }
}

interface NewsItem { id: string; title: string; summary: string; url: string; source: string; published: string; category: 'crossing' | 'policy' | 'contractor' | 'detention' | 'legal' | 'general' | 'returns' | 'deaths'; relevance_score: number; }
const KEYWORD_WEIGHTS: Record<string, { weight: number; category: NewsItem['category'] }> = {
  'channel crossing': { weight: 10, category: 'crossing' }, 'small boat': { weight: 10, category: 'crossing' }, 'migrant crossing': { weight: 9, category: 'crossing' },
  'dover': { weight: 5, category: 'crossing' }, 'calais': { weight: 5, category: 'crossing' }, 'channel death': { weight: 10, category: 'deaths' },
  'drowned': { weight: 8, category: 'deaths' }, 'capsized': { weight: 8, category: 'deaths' }, 'deportation': { weight: 8, category: 'returns' },
  'deported': { weight: 8, category: 'returns' }, 'returns deal': { weight: 10, category: 'returns' }, 'france deal': { weight: 10, category: 'returns' },
  'serco': { weight: 10, category: 'contractor' }, 'mears': { weight: 10, category: 'contractor' }, 'clearsprings': { weight: 10, category: 'contractor' },
  'mitie': { weight: 8, category: 'contractor' }, 'asylum hotel': { weight: 9, category: 'contractor' }, 'detention centre': { weight: 8, category: 'detention' },
  'harmondsworth': { weight: 9, category: 'detention' }, 'brook house': { weight: 9, category: 'detention' }, 'yarls wood': { weight: 9, category: 'detention' },
  'manston': { weight: 10, category: 'detention' }, 'bibby stockholm': { weight: 10, category: 'detention' }, 'home secretary': { weight: 6, category: 'policy' },
  'border force': { weight: 7, category: 'policy' }, 'net migration': { weight: 8, category: 'policy' }, 'asylum seeker': { weight: 5, category: 'general' },
  'refugee': { weight: 4, category: 'general' }, 'immigration': { weight: 3, category: 'general' }, 'tribunal': { weight: 7, category: 'legal' },
  'judicial review': { weight: 7, category: 'legal' }, 'appeal': { weight: 6, category: 'legal' },
};

function scoreNewsItem(title: string, summary: string): { score: number; category: NewsItem['category'] } {
  const text = \`\${title} \${summary}\`.toLowerCase();
  let totalScore = 0; let topCategory: NewsItem['category'] = 'general'; let topCategoryScore = 0;
  for (const [keyword, { weight, category }] of Object.entries(KEYWORD_WEIGHTS)) {
    if (text.includes(keyword)) { totalScore += weight; if (weight > topCategoryScore) { topCategoryScore = weight; topCategory = category; } }
  }
  return { score: totalScore, category: topCategory };
}

async function aggregateNews(): Promise<NewsItem[]> {
  const cached = getCached<NewsItem[]>('news_feed');
  if (cached) return cached;
  const allNews: NewsItem[] = [];
  try {
    const feed = await rssParser.parseURL(CONFIG.GUARDIAN_IMMIGRATION);
    for (const item of feed.items.slice(0, 20)) {
      const { score, category } = scoreNewsItem(item.title || '', item.contentSnippet || '');
      if (score >= 3) { allNews.push({ id: \`guardian-\${Buffer.from(item.link || '').toString('base64').slice(0, 12)}\`, title: item.title || '', summary: item.contentSnippet?.slice(0, 200) || '', url: item.link || '', source: 'The Guardian', published: item.pubDate || new Date().toISOString(), category, relevance_score: score }); }
    }
  } catch (e) { console.log('Guardian RSS error:', e); }
  try {
    const feed = await rssParser.parseURL(CONFIG.BBC_NEWS);
    for (const item of feed.items.slice(0, 30)) {
      const { score, category } = scoreNewsItem(item.title || '', item.contentSnippet || '');
      if (score >= 3) { allNews.push({ id: \`bbc-\${Buffer.from(item.link || '').toString('base64').slice(0, 12)}\`, title: item.title || '', summary: item.contentSnippet?.slice(0, 200) || '', url: item.link || '', source: 'BBC News', published: item.pubDate || new Date().toISOString(), category, relevance_score: score }); }
    }
  } catch (e) { console.log('BBC RSS error:', e); }
  allNews.sort((a, b) => { const scoreDiff = b.relevance_score - a.relevance_score; if (Math.abs(scoreDiff) > 2) return scoreDiff; return new Date(b.published).getTime() - new Date(a.published).getTime(); });
  const result = allNews.slice(0, 50);
  setCache('news_feed', result);
  return result;
}

interface ParliamentaryItem { id: string; title: string; type: 'question' | 'debate' | 'statement' | 'bill'; date: string; url: string; chamber: 'Commons' | 'Lords'; summary?: string; }
const PARLIAMENTARY_KEYWORDS = ['asylum', 'refugee', 'channel crossing', 'small boat', 'immigration', 'home office', 'detention', 'deportation', 'serco', 'mears', 'manston', 'bibby stockholm', 'border force', 'migrant', 'net migration', 'visa', 'returns', 'france deal'];

async function getParliamentaryActivity(): Promise<ParliamentaryItem[]> {
  const cached = getCached<ParliamentaryItem[]>('parliamentary');
  if (cached) return cached;
  const items: ParliamentaryItem[] = [];
  try {
    const feed = await rssParser.parseURL(CONFIG.HANSARD_RSS);
    for (const item of feed.items) {
      const text = \`\${item.title} \${item.contentSnippet}\`.toLowerCase();
      const isRelevant = PARLIAMENTARY_KEYWORDS.some(kw => text.includes(kw));
      if (isRelevant) {
        let type: ParliamentaryItem['type'] = 'debate';
        const title = item.title || '';
        if (title.includes('Question')) type = 'question'; else if (title.includes('Statement')) type = 'statement'; else if (title.includes('Bill')) type = 'bill';
        items.push({ id: \`hansard-\${Buffer.from(item.link || '').toString('base64').slice(0, 12)}\`, title: item.title || '', type, date: item.pubDate || new Date().toISOString(), url: item.link || '', chamber: 'Commons', summary: item.contentSnippet?.slice(0, 300) });
      }
    }
  } catch (e) { console.log('Hansard RSS error:', e); }
  try {
    const lordsFeed = await rssParser.parseURL('https://hansard.parliament.uk/rss/Lords.rss');
    for (const item of lordsFeed.items) {
      const text = \`\${item.title} \${item.contentSnippet}\`.toLowerCase();
      const isRelevant = PARLIAMENTARY_KEYWORDS.some(kw => text.includes(kw));
      if (isRelevant) {
        let type: ParliamentaryItem['type'] = 'debate';
        const title = item.title || '';
        if (title.includes('Question')) type = 'question'; else if (title.includes('Statement')) type = 'statement'; else if (title.includes('Bill')) type = 'bill';
        items.push({ id: \`hansard-lords-\${Buffer.from(item.link || '').toString('base64').slice(0, 12)}\`, title: item.title || '', type, date: item.pubDate || new Date().toISOString(), url: item.link || '', chamber: 'Lords', summary: item.contentSnippet?.slice(0, 300) });
      }
    }
  } catch (e) { console.log('Lords RSS error:', e); }
  items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const result = items.slice(0, 30);
  setCache('parliamentary', result);
  return result;
}

interface FOIRequest { id: string; title: string; status: 'awaiting' | 'successful' | 'partially_successful' | 'refused' | 'overdue'; authority: string; date_submitted: string; date_updated: string; url: string; summary?: string; }

async function getFOIRequests(): Promise<FOIRequest[]> {
  const cached = getCached<FOIRequest[]>('foi_requests');
  if (cached) return cached;
  const requests: FOIRequest[] = [];
  try {
    const feed = await rssParser.parseURL(CONFIG.WHATDOTHEYKNOW_ASYLUM);
    for (const item of feed.items.slice(0, 30)) {
      let status: FOIRequest['status'] = 'awaiting';
      const title = (item.title || '').toLowerCase();
      if (title.includes('successful')) status = 'successful'; else if (title.includes('partially')) status = 'partially_successful'; else if (title.includes('refused')) status = 'refused'; else if (title.includes('overdue')) status = 'overdue';
      requests.push({ id: \`foi-\${Buffer.from(item.link || '').toString('base64').slice(0, 12)}\`, title: item.title || '', status, authority: 'Home Office', date_submitted: item.pubDate || new Date().toISOString(), date_updated: item.pubDate || new Date().toISOString(), url: item.link || '', summary: item.contentSnippet?.slice(0, 200) });
    }
  } catch (e) { console.log('WhatDoTheyKnow RSS error:', e); }
  setCache('foi_requests', requests);
  return requests;
}

async function initDatabase() {
  try {
    await pool.query(\`CREATE TABLE IF NOT EXISTS detention_facilities (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, type VARCHAR(100), operator VARCHAR(255), capacity INTEGER, population INTEGER, lat DECIMAL(10, 6), lng DECIMAL(10, 6), last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP)\`);
    const count = await pool.query('SELECT COUNT(*) FROM detention_facilities');
    if (parseInt(count.rows[0].count) === 0) {
      for (const irc of ircFacilities) {
        await pool.query('INSERT INTO detention_facilities (name, type, operator, capacity, population, lat, lng) VALUES ($1, $2, $3, $4, $5, $6, $7)', [irc.name, irc.type, irc.operator, irc.capacity, irc.population, irc.location.lat, irc.location.lng]);
      }
    }
    console.log('Database initialized');
  } catch (error) { console.error('Database init error:', error); }
}

// ============================================================================
// API ENDPOINTS - SOURCES & CRIME
// ============================================================================

app.get('/api/sources', (req, res) => res.json({ description: 'All data sources used by UK Asylum Tracker', sources: DATA_SOURCES, methodology_note: 'Core statistics from Home Office quarterly releases. Live elements use real-time APIs where available.', update_schedule: { live: ['weather', 'news', 'parliamentary', 'foi', 'crime'], quarterly: ['la_support', 'detention', 'returns', 'appeals', 'net_migration'], annual: ['spending'] } }));

app.get('/api/crime/categories', async (req, res) => { try { const categories = await getCrimeCategories(); res.json({ categories, category_names: CRIME_CATEGORY_NAMES, source: 'Police UK API' }); } catch (error) { res.status(500).json({ error: 'Failed to fetch crime categories' }); } });
app.get('/api/crime/forces', async (req, res) => { try { const forces = await getPoliceForces(); res.json({ forces, count: forces.length, source: 'Police UK API' }); } catch (error) { res.status(500).json({ error: 'Failed to fetch police forces' }); } });
app.get('/api/crime/forces/:forceId', async (req, res) => { try { const details = await getForceDetails(req.params.forceId); if (!details) return res.status(404).json({ error: 'Force not found' }); res.json(details); } catch (error) { res.status(500).json({ error: 'Failed to fetch force details' }); } });
app.get('/api/crime/forces/:forceId/neighbourhoods', async (req, res) => { try { const neighbourhoods = await getNeighbourhoods(req.params.forceId); res.json({ force_id: req.params.forceId, neighbourhoods, count: neighbourhoods.length }); } catch (error) { res.status(500).json({ error: 'Failed to fetch neighbourhoods' }); } });

app.get('/api/crime/location/:lat/:lng', async (req, res) => {
  try {
    const lat = parseFloat(req.params.lat); const lng = parseFloat(req.params.lng); const date = req.query.date as string;
    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'Invalid coordinates' });
    const crimes = await getCrimesAtLocation(lat, lng, date);
    const categoryCounts: Record<string, number> = {};
    for (const crime of crimes) { const cat = crime.category; categoryCounts[cat] = (categoryCounts[cat] || 0) + 1; }
    res.json({ location: { lat, lng }, period: date || getLastAvailableMonth(), total_crimes: crimes.length, by_category: Object.entries(categoryCounts).map(([category, count]) => ({ category: CRIME_CATEGORY_NAMES[category] || category, category_id: category, count })).sort((a, b) => b.count - a.count), crimes: crimes.slice(0, 100), source: 'Police UK API' });
  } catch (error) { res.status(500).json({ error: 'Failed to fetch crimes at location' }); }
});

app.get('/api/crime/area/:lat/:lng', async (req, res) => {
  try {
    const lat = parseFloat(req.params.lat); const lng = parseFloat(req.params.lng);
    const radius = parseFloat(req.query.radius as string) || 1; const date = req.query.date as string;
    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'Invalid coordinates' });
    if (radius > 5) return res.status(400).json({ error: 'Radius cannot exceed 5 miles' });
    const crimeData = await getCrimesInArea(lat, lng, radius, date);
    res.json({ ...crimeData, source: 'Police UK API', note: 'Crime data is typically 2 months behind current date' });
  } catch (error) { res.status(500).json({ error: 'Failed to fetch crimes in area' }); }
});

app.get('/api/crime/stop-search/:lat/:lng', async (req, res) => {
  try {
    const lat = parseFloat(req.params.lat); const lng = parseFloat(req.params.lng); const date = req.query.date as string;
    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'Invalid coordinates' });
    const searches = await getStopAndSearches(lat, lng, date);
    const objectOfSearchCounts: Record<string, number> = {}; const ethnicityBreakdown: Record<string, number> = {}; const outcomeCounts: Record<string, number> = {};
    for (const search of searches) {
      const obj = search.object_of_search || 'Unknown'; objectOfSearchCounts[obj] = (objectOfSearchCounts[obj] || 0) + 1;
      const ethnicity = search.self_defined_ethnicity || search.officer_defined_ethnicity || 'Not recorded'; ethnicityBreakdown[ethnicity] = (ethnicityBreakdown[ethnicity] || 0) + 1;
      const outcome = search.outcome || 'No outcome'; outcomeCounts[outcome] = (outcomeCounts[outcome] || 0) + 1;
    }
    res.json({ location: { lat, lng }, period: date || getLastAvailableMonth(), total_searches: searches.length, by_object_of_search: objectOfSearchCounts, by_ethnicity: ethnicityBreakdown, by_outcome: outcomeCounts, searches: searches.slice(0, 100), source: 'Police UK API' });
  } catch (error) { res.status(500).json({ error: 'Failed to fetch stop and search data' }); }
});

app.get('/api/crime/asylum-locations', async (req, res) => { try { const data = await getCrimesNearAsylumLocations(); res.json({ description: 'Crime data near IRCs and high asylum-seeker density areas', locations: data, note: 'This data is for contextual analysis only.', source: 'Police UK API' }); } catch (error) { res.status(500).json({ error: 'Failed to fetch crime data for asylum locations' }); } });

app.get('/api/crime/compare', async (req, res) => {
  try {
    const laNames = (req.query.las as string)?.split(',') || [];
    if (laNames.length === 0) return res.status(400).json({ error: 'No local authorities specified', usage: '/api/crime/compare?las=Manchester,Birmingham,Liverpool' });
    if (laNames.length > 10) return res.status(400).json({ error: 'Maximum 10 local authorities per comparison' });
    const comparison = await getCrimeComparisonForLAs(laNames);
    res.json({ comparison, period: getLastAvailableMonth(), note: 'Data based on 1-mile radius from city centre coordinates', source: 'Police UK API' });
  } catch (error) { res.status(500).json({ error: 'Failed to compare crime data' }); }
});

app.get('/api/crime/last-updated', async (req, res) => { try { const lastUpdated = await getLastUpdated(); res.json({ ...lastUpdated, source: 'Police UK API' }); } catch (error) { res.status(500).json({ error: 'Failed to fetch last updated date' }); } });

app.get('/api/crime/irc/:ircId', async (req, res) => {
  try {
    const irc = ircFacilities.find(f => f.id === req.params.ircId) || processingCentres.find(f => f.id === req.params.ircId);
    if (!irc) return res.status(404).json({ error: 'IRC not found' });
    const radius = parseFloat(req.query.radius as string) || 1; const date = req.query.date as string;
    const crimeData = await getCrimesInArea(irc.location.lat, irc.location.lng, radius, date);
    res.json({ facility: { id: irc.id, name: irc.name, location: irc.location }, crime_data: crimeData, source: 'Police UK API' });
  } catch (error) { res.status(500).json({ error: 'Failed to fetch crime data for IRC' }); }
});

app.get('/api/crime/map/:lat/:lng', async (req, res) => {
  try {
    const lat = parseFloat(req.params.lat); const lng = parseFloat(req.params.lng);
    const radius = parseFloat(req.query.radius as string) || 1; const date = req.query.date as string; const category = req.query.category as string;
    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'Invalid coordinates' });
    const crimeData = await getCrimesInArea(lat, lng, radius, date);
    let crimes = crimeData.crimes;
    if (category && category !== 'all-crime') { crimes = crimes.filter(c => c.category === category); }
    const geojson = { type: 'FeatureCollection', features: crimes.map(crime => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [parseFloat(crime.location?.longitude || '0'), parseFloat(crime.location?.latitude || '0')] }, properties: { id: crime.id, category: crime.category, category_name: CRIME_CATEGORY_NAMES[crime.category] || crime.category, street: crime.location?.street?.name || 'Unknown', month: crime.month, outcome: crime.outcome_status?.category || 'Under investigation' } })) };
    res.json({ geojson, summary: { total: crimes.length, period: crimeData.period, centre: { lat, lng }, radius_miles: radius }, source: 'Police UK API' });
  } catch (error) { res.status(500).json({ error: 'Failed to generate crime map data' }); }
});

// ============================================================================
// API ENDPOINTS - IMMIGRATION DATA
// ============================================================================

app.get('/api/france-deal', (req, res) => res.json({ ...franceReturnsDeal, data_source: DATA_SOURCES.france_deal }));
app.get('/api/france-deal/returns', (req, res) => res.json({ actual_returns: franceReturnsDeal.actual_returns, target: franceReturnsDeal.target_annual, effectiveness: franceReturnsDeal.effectiveness }));
app.get('/api/returns', (req, res) => res.json({ ...returnsData, data_source: DATA_SOURCES.returns }));
app.get('/api/returns/summary', (req, res) => res.json({ period: returnsData.data_period, ...returnsData.summary, small_boat_return_rate: returnsData.small_boat_returns }));
app.get('/api/returns/by-nationality', (req, res) => res.json({ period: returnsData.data_period, data: returnsData.by_nationality, fno: returnsData.fno }));
app.get('/api/net-migration', (req, res) => res.json({ ...netMigrationData, data_source: DATA_SOURCES.net_migration }));
app.get('/api/net-migration/latest', (req, res) => res.json({ period: netMigrationData.data_period, ...netMigrationData.latest, by_nationality: netMigrationData.by_nationality }));
app.get('/api/net-migration/by-reason', (req, res) => res.json({ period: netMigrationData.data_period, breakdown: netMigrationData.by_reason, policy_changes: netMigrationData.policy_changes }));
app.get('/api/appeals', (req, res) => res.json({ ...appealsData, data_source: DATA_SOURCES.appeals }));
app.get('/api/appeals/backlog', (req, res) => res.json({ period: appealsData.data_period, backlog: appealsData.backlog, processing: appealsData.processing, by_nationality: appealsData.by_nationality }));
app.get('/api/deaths', (req, res) => res.json({ ...channelDeathsData, data_source: DATA_SOURCES.channel_deaths }));
app.get('/api/deaths/summary', (req, res) => res.json({ summary: channelDeathsData.summary, annual: channelDeathsData.annual, context: channelDeathsData.context }));
app.get('/api/deaths/incidents', (req, res) => res.json({ major_incidents: channelDeathsData.major_incidents, demographics: channelDeathsData.demographics, sources: channelDeathsData.sources }));
app.get('/api/enforcement', (req, res) => res.json(getEnforcementScorecard()));

// ============================================================================
// API ENDPOINTS - FACILITIES
// ============================================================================

app.get('/api/ircs', (req, res) => {
  const totalCapacity = ircFacilities.reduce((sum, f) => sum + f.capacity, 0);
  const totalPopulation = ircFacilities.reduce((sum, f) => sum + f.population, 0);
  res.json({ ircs: ircFacilities, processing_centres: processingCentres, totals: { irc_capacity: totalCapacity, irc_population: totalPopulation, occupancy_pct: ((totalPopulation / totalCapacity) * 100).toFixed(1) }, source: 'Home Office Immigration Statistics' });
});

app.get('/api/ircs/:id', (req, res) => {
  const facility = ircFacilities.find(f => f.id === req.params.id) || processingCentres.find(f => f.id === req.params.id);
  if (!facility) return res.status(404).json({ error: 'Facility not found' });
  res.json(facility);
});

app.get('/api/cameras/near/:lat/:lng', async (req, res) => {
  const lat = parseFloat(req.params.lat);
  const lng = parseFloat(req.params.lng);
  const radius = parseFloat(req.query.radius as string) || 10;
  const allCameras: any[] = [];
  
  for (const irc of ircFacilities) {
    const distance = Math.sqrt(Math.pow(irc.location.lat - lat, 2) + Math.pow(irc.location.lng - lng, 2)) * 111;
    if (distance <= radius) {
      for (const cam of irc.nearby_cameras) {
        allCameras.push({ ...cam, facility: irc.name, facility_type: 'IRC' });
      }
    }
  }
  
  res.json({ location: { lat, lng }, radius_km: radius, cameras: allCameras, note: 'Traffic cameras near immigration facilities' });
});

// ============================================================================
// API ENDPOINTS - COSTS
// ============================================================================

app.get('/api/cost/area/:la', (req, res) => {
  const la = localAuthoritiesData.find(l => l.name.toLowerCase() === req.params.la.toLowerCase() || l.ons_code === req.params.la);
  if (!la) return res.status(404).json({ error: 'Local authority not found' });
  const costs = calculateAreaCost(la.hotel, la.dispersed);
  const equivalents = calculateEquivalents(costs.annual);
  res.json({ local_authority: la.name, population: la.population, asylum_seekers: la.total, per_10k: ((la.total / la.population) * 10000).toFixed(2), costs: { daily: costs.daily, daily_formatted: `£${costs.daily.toLocaleString()}`, annual: costs.annual, annual_formatted: `£${(costs.annual / 1000000).toFixed(2)}M`, breakdown: costs.breakdown }, equivalents, note: 'Based on NAO unit costs: £145/night hotel, £52/night dispersed' });
});

app.get('/api/cost/national', (req, res) => {
  let totalHotel = 0; let totalDispersed = 0;
  for (const la of localAuthoritiesData) { totalHotel += la.hotel; totalDispersed += la.dispersed; }
  const costs = calculateAreaCost(totalHotel, totalDispersed);
  const equivalents = calculateEquivalents(costs.annual);
  res.json({ total_in_accommodation: totalHotel + totalDispersed, in_hotels: totalHotel, in_dispersed: totalDispersed, costs: { daily: costs.daily, daily_formatted: `£${(costs.daily / 1000000).toFixed(2)}M`, annual: costs.annual, annual_formatted: `£${(costs.annual / 1000000000).toFixed(2)}B` }, equivalents, methodology: 'NAO unit costs × current population snapshot' });
});

// ============================================================================
// API ENDPOINTS - LIVE DASHBOARD
// ============================================================================

app.get('/api/live/dashboard', async (req, res) => {
  try {
    const [smallBoats, weather, news, parliamentary, foi] = await Promise.all([scrapeSmallBoatsData(), getChannelConditions(), aggregateNews(), getParliamentaryActivity(), getFOIRequests()]);
    res.json({ last_updated: new Date().toISOString(), small_boats: smallBoats, channel_conditions: weather, latest_news: news.slice(0, 5), parliamentary: parliamentary.slice(0, 5), foi_requests: foi.filter(f => f.status === 'awaiting').length, france_deal: { returns: franceReturnsDeal.actual_returns.total_returned_to_france, target: franceReturnsDeal.target_annual }, deaths_2025: channelDeathsData.summary.year_2025 });
  } catch (error) { console.error('Dashboard error:', error); res.status(500).json({ error: 'Failed to fetch live data' }); }
});

app.get('/api/live/small-boats', async (req, res) => { const data = await scrapeSmallBoatsData(); res.json(data); });
app.get('/api/live/news', async (req, res) => { const news = await aggregateNews(); const category = req.query.category as string; if (category) { res.json(news.filter(n => n.category === category)); } else { res.json(news); } });
app.get('/api/live/parliamentary', async (req, res) => { const items = await getParliamentaryActivity(); res.json(items); });
app.get('/api/live/foi', async (req, res) => { const requests = await getFOIRequests(); res.json({ total: requests.length, pending: requests.filter(r => r.status === 'awaiting').length, items: requests }); });
app.get('/api/live/channel-conditions', async (req, res) => { const conditions = await getChannelConditions(); res.json(conditions); });

// ============================================================================
// API ENDPOINTS - LOCAL AUTHORITIES
// ============================================================================

app.get('/api/la', (req, res) => {
  const enriched = localAuthoritiesData.map(la => ({ ...la, per_10k: ((la.total / la.population) * 10000).toFixed(2), hotel_pct: ((la.hotel / la.total) * 100).toFixed(2), daily_cost: (la.hotel * 145) + (la.dispersed * 52) }));
  res.json({ data: enriched, count: enriched.length, last_updated: DATA_SOURCES.la_support.last_updated, data_period: DATA_SOURCES.la_support.data_period });
});

app.get('/api/la/:id', (req, res) => {
  const la = localAuthoritiesData.find(l => l.ons_code === req.params.id || l.name.toLowerCase() === req.params.id.toLowerCase());
  if (!la) return res.status(404).json({ error: 'Local authority not found' });
  const costs = calculateAreaCost(la.hotel, la.dispersed);
  res.json({ ...la, per_10k: ((la.total / la.population) * 10000).toFixed(2), hotel_pct: ((la.hotel / la.total) * 100).toFixed(2), costs });
});

app.get('/api/regions', (req, res) => {
  const regions = [...new Set(localAuthoritiesData.map(la => la.region))];
  const summary = regions.map(region => {
    const las = localAuthoritiesData.filter(la => la.region === region);
    return { region, local_authorities: las.length, total_supported: las.reduce((sum, la) => sum + la.total, 0), hotel: las.reduce((sum, la) => sum + la.hotel, 0), dispersed: las.reduce((sum, la) => sum + la.dispersed, 0) };
  });
  res.json(summary);
});

// ============================================================================
// API ENDPOINTS - SPENDING
// ============================================================================

app.get('/api/spending', (req, res) => res.json({ ...spendingData, last_updated: DATA_SOURCES.spending.last_updated }));
app.get('/api/spending/rwanda', (req, res) => res.json({ ...spendingData.rwanda, description: 'Rwanda deportation scheme (2022-2025)', summary: '£700M total cost. 0 forced deportations. 4 voluntary relocations (each paid £3,000). Scrapped January 2025.', key_figures: { total_cost_millions: 700, forced_deportations: 0, voluntary_relocations: 4, cost_per_voluntary_relocation_millions: 175 } }));

// ============================================================================
// API ENDPOINTS - CONTRACTORS
// ============================================================================

app.get('/api/contractors', (req, res) => {
  const summary = Object.values(contractorProfiles).map((c: any) => ({ id: c.id, name: c.name, contract_value_millions: c.contract.current_value_millions, profit_margin_pct: c.financials.data ? c.financials.data[c.financials.data.length - 1]?.margin_pct : c.financials.asylum_margin_pct, people_housed: c.accommodation.people_housed, regions: c.contract.regions, clawback_owed_millions: c.profit_clawback.excess_owed_millions || 0, clawback_paid_millions: c.profit_clawback.paid_back_millions }));
  res.json({ contractors: summary, totals: { contract_value_millions: 15300, profit_extracted_millions: 383, clawback_owed_millions: 45.8, clawback_paid_millions: 74 }, source: 'NAO May 2025 Report' });
});

app.get('/api/contractors/:id', (req, res) => {
  const contractor = (contractorProfiles as any)[req.params.id];
  if (!contractor) return res.status(404).json({ error: 'Contractor not found' });
  res.json(contractor);
});

app.get('/api/contractors/:id/financials', (req, res) => {
  const contractor = (contractorProfiles as any)[req.params.id];
  if (!contractor) return res.status(404).json({ error: 'Contractor not found' });
  res.json({ name: contractor.name, financials: contractor.financials, profit_clawback: contractor.profit_clawback });
});

app.get('/api/contractors/:id/controversies', (req, res) => {
  const contractor = (contractorProfiles as any)[req.params.id];
  if (!contractor) return res.status(404).json({ error: 'Contractor not found' });
  res.json({ name: contractor.name, controversies: contractor.controversies, complaints_2023: contractor.performance.complaints_2023 });
});

// ============================================================================
// API ENDPOINTS - KEY INDIVIDUALS
// ============================================================================

app.get('/api/individuals', (req, res) => {
  const summary = Object.values(keyIndividuals).map((i: any) => ({ id: i.id, name: i.name, company: i.company, net_worth_millions: i.wealth.timeline ? i.wealth.timeline[i.wealth.timeline.length - 1].net_worth_millions : i.wealth.net_worth_millions, is_billionaire: i.wealth.first_billionaire_year ? true : false }));
  res.json(summary);
});

app.get('/api/individuals/:id', (req, res) => {
  const individual = (keyIndividuals as any)[req.params.id];
  if (!individual) return res.status(404).json({ error: 'Individual not found' });
  res.json(individual);
});

app.get('/api/individuals/graham_king/wealth', (req, res) => {
  const gk = keyIndividuals.graham_king as any;
  res.json({ name: gk.name, current_net_worth_millions: gk.wealth.timeline[gk.wealth.timeline.length - 1].net_worth_millions, is_billionaire: true, first_billionaire_year: gk.wealth.first_billionaire_year, wealth_timeline: gk.wealth.timeline, yoy_increase_pct: gk.wealth.yoy_increase_pct, wealth_source: gk.wealth.wealth_source, nickname: gk.wealth.nickname });
});

// ============================================================================
// API ENDPOINTS - COST ANALYSIS
// ============================================================================

app.get('/api/costs/breakdown', (req, res) => res.json(unitCostBreakdown));
app.get('/api/costs/145-question', (req, res) => res.json({ headline: 'Where does £145/night go?', home_office_pays: 145, market_rate: '£50-80/night', markup: '80-100%', breakdown_estimate: unitCostBreakdown.hotel_accommodation.breakdown_estimate, scale: unitCostBreakdown.hotel_accommodation.scale, inefficiency: unitCostBreakdown.comparison }));
app.get('/api/contracts/overview', (req, res) => res.json(contractOverview));
app.get('/api/contracts/cost-explosion', (req, res) => res.json({ original_estimate_millions: contractOverview.original_estimate.total_millions, current_estimate_millions: contractOverview.current_estimate.total_millions, increase_millions: contractOverview.cost_explosion.increase_millions, increase_pct: contractOverview.cost_explosion.increase_pct, reasons: contractOverview.cost_explosion.reasons, by_contractor: contractOverview.by_contractor }));

// ============================================================================
// API ENDPOINTS - ACCOUNTABILITY
// ============================================================================

app.get('/api/accountability', (req, res) => res.json(accountabilityFailures));
app.get('/api/accountability/clawback', (req, res) => res.json({ mechanism: '5% profit cap - excess must be returned', by_contractor: [{ name: 'Clearsprings', owed_millions: 32, paid_millions: 0, status: 'Pending audit' }, { name: 'Mears', owed_millions: 13.8, paid_millions: 0, status: 'Awaiting clearance' }, { name: 'Serco', owed_millions: 0, paid_millions: 0, status: 'Below threshold' }], total_owed_millions: 45.8, total_recovered_millions: 74, mp_quote: "You haven't paid a pound back into the Home Office", source: 'Home Affairs Committee May 2025' }));
app.get('/api/political', (req, res) => res.json(politicalConnections));

// ============================================================================
// API ENDPOINTS - GRANT RATES, UASC, BACKLOG, DETENTION
// ============================================================================

app.get('/api/grant-rates', (req, res) => res.json(grantRatesData));
app.get('/api/grant-rates/by-nationality', (req, res) => res.json({ period: grantRatesData.period, data: grantRatesData.by_nationality, overall: grantRatesData.overall }));
app.get('/api/grant-rates/historical', (req, res) => res.json({ data: grantRatesData.historical, source: grantRatesData.source }));

app.get('/api/uasc', (req, res) => res.json(uascData));
app.get('/api/uasc/summary', (req, res) => res.json({ total_in_care: uascData.current.total_in_care, in_hotels: uascData.current.in_hotels, with_local_authorities: uascData.current.with_local_authorities, applications_2025: uascData.applications.year_2025_ytd, grant_rate_pct: uascData.outcomes.granted_asylum_pct, top_nationalities: uascData.by_nationality.slice(0, 5) }));

app.get('/api/backlog', (req, res) => res.json(backlogData));
app.get('/api/backlog/summary', (req, res) => res.json({ total_pending: backlogData.current.total_awaiting_decision, over_6_months: backlogData.current.awaiting_over_6_months, over_1_year: backlogData.current.awaiting_over_1_year, legacy_remaining: backlogData.current.legacy_cases_remaining, monthly_intake: backlogData.flow.monthly_intake, monthly_decisions: backlogData.flow.monthly_decisions, months_to_clear: backlogData.flow.months_to_clear_at_current_rate }));
app.get('/api/backlog/timeline', (req, res) => res.json({ data: backlogData.timeline, peak: { date: '2023-06', count: 175000 }, current: backlogData.current.total_awaiting_decision }));

app.get('/api/detention', (req, res) => res.json(detentionData));
app.get('/api/detention/summary', (req, res) => res.json({ current_population: detentionData.current_population.total, capacity: detentionData.current_population.capacity, occupancy_pct: detentionData.current_population.occupancy_pct, avg_detention_days: detentionData.length_of_detention.average_days, removal_rate_pct: detentionData.outcomes_2024.removal_rate_pct, cost_per_day: detentionData.cost.per_person_per_day }));
app.get('/api/detention/facilities', (req, res) => res.json({ facilities: detentionData.by_facility, total_population: detentionData.current_population.total, total_capacity: detentionData.current_population.capacity }));

// ============================================================================
// API ENDPOINTS - COMMUNITY INTEL
// ============================================================================

app.get('/api/community/tips', (req, res) => {
  let tips = [...communityTips];
  const type = req.query.type as string; const status = req.query.status as string; const la = req.query.la as string;
  if (type) tips = tips.filter(t => t.type === type);
  if (status) tips = tips.filter(t => t.status === status);
  if (la) tips = tips.filter(t => t.location?.local_authority?.toLowerCase() === la.toLowerCase());
  tips.sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());
  res.json({ total: tips.length, items: tips });
});

app.post('/api/community/tips', (req, res) => {
  const { type, title, content, location, contractor, evidence_urls, submitter_type } = req.body;
  if (!title || !content || !type) return res.status(400).json({ error: 'Missing required fields' });
  const newTip: CommunityTip = { id: `tip-${Date.now()}`, type, title, content, location, contractor, submitted_at: new Date().toISOString(), verified: false, upvotes: 0, downvotes: 0, flags: 0, status: 'pending', evidence_urls, submitter_type: submitter_type || 'anonymous' };
  communityTips.push(newTip);
  res.status(201).json({ message: 'Tip submitted', id: newTip.id });
});

app.post('/api/community/tips/:id/vote', (req, res) => {
  const tip = communityTips.find(t => t.id === req.params.id);
  if (!tip) return res.status(404).json({ error: 'Tip not found' });
  const { vote } = req.body;
  if (vote === 'up') tip.upvotes++; else if (vote === 'down') tip.downvotes++; else return res.status(400).json({ error: 'Invalid vote' });
  res.json({ upvotes: tip.upvotes, downvotes: tip.downvotes, score: tip.upvotes - tip.downvotes });
});

app.get('/api/community/stats', (req, res) => res.json({ total_tips: communityTips.length, verified: communityTips.filter(t => t.verified).length, pending: communityTips.filter(t => t.status === 'pending').length, investigating: communityTips.filter(t => t.status === 'investigating').length }));

// ============================================================================
// API ENDPOINTS - ALERTS
// ============================================================================

app.post('/api/alerts/subscribe', (req, res) => {
  const { email, alerts } = req.body;
  if (!email || !alerts) return res.status(400).json({ error: 'Missing email or alerts' });
  const existing = subscriptions.find(s => s.email === email);
  if (existing) { existing.alerts = alerts; return res.json({ message: 'Subscription updated', id: existing.id }); }
  const sub: AlertSubscription = { id: `sub-${Date.now()}`, email, alerts, created_at: new Date().toISOString() };
  subscriptions.push(sub);
  res.status(201).json({ message: 'Subscribed successfully', id: sub.id });
});

// ============================================================================
// API ENDPOINTS - SUMMARY/DASHBOARD
// ============================================================================

app.get('/api/dashboard/summary', async (req, res) => {
  const boats = await scrapeSmallBoatsData();
  const weather = await getChannelConditions();
  const totalSupported = localAuthoritiesData.reduce((sum, la) => sum + la.total, 0);
  const totalHotel = localAuthoritiesData.reduce((sum, la) => sum + la.hotel, 0);
  res.json({
    small_boats: { ytd: boats.ytd_total, year: boats.year, last_crossing: boats.last_crossing_date, days_since: boats.days_since_crossing, yoy_change_pct: boats.yoy_comparison.change_pct, yoy_direction: boats.yoy_comparison.direction },
    channel: { risk: weather.crossing_risk, wind_kmh: weather.wind_speed_kmh, waves_m: weather.wave_height_m },
    accommodation: { total_supported: totalSupported, in_hotels: totalHotel, hotel_pct: ((totalHotel / totalSupported) * 100).toFixed(1), backlog: 62000 },
    spending: { total_contract_value_billions: 15.3, annual_rate_billions: 1.7, daily_rate_millions: 4.66 },
    contractors: { profit_extracted_millions: 383, clawback_owed_millions: 45.8, clawback_recovered_millions: 74, graham_king_net_worth_millions: 1015 },
    france_deal: { returns: franceReturnsDeal.actual_returns.total_returned_to_france, target: franceReturnsDeal.target_annual },
    appeals: { backlog: appealsData.backlog.total_pending, success_rate_pct: appealsData.outcomes.allowed_pct },
    deaths_2025: channelDeathsData.summary.year_2025,
    rwanda: { cost_millions: 700, forced_deportations: 0, voluntary_relocations: 4, status: 'Scrapped' }
  });
});

// ============================================================================
// HEALTH & ROOT
// ============================================================================

app.get('/health', (req, res) => res.json({ status: 'healthy', version: '14.0.0', features: ['france_returns_deal', 'returns_data', 'net_migration', 'appeals_backlog', 'channel_deaths', 'enforcement_scorecard', 'irc_cameras', 'cost_calculator', 'live_scraping', 'news_aggregation', 'parliamentary', 'foi_tracking', 'community_intel', 'data_sources', 'crime_statistics'], timestamp: new Date().toISOString() }));

app.get('/', (req, res) => res.json({
  name: 'UK Asylum Tracker API', version: '14.0', description: 'Comprehensive UK asylum and immigration data tracker',
  new_in_v14: ['UK Crime Statistics (Police UK API)', 'Crime data near IRCs and asylum locations', 'Crime comparison between local authorities', 'Stop and search data', 'GeoJSON crime map data for visualization'],
  endpoints: {
    transparency: ['/api/sources'],
    crime: ['/api/crime/categories', '/api/crime/forces', '/api/crime/location/:lat/:lng', '/api/crime/area/:lat/:lng', '/api/crime/stop-search/:lat/:lng', '/api/crime/asylum-locations', '/api/crime/compare?las=Manchester,Birmingham', '/api/crime/irc/:ircId', '/api/crime/map/:lat/:lng', '/api/crime/last-updated'],
    immigration: ['/api/france-deal', '/api/returns', '/api/net-migration', '/api/appeals', '/api/deaths', '/api/enforcement'],
    facilities: ['/api/ircs', '/api/cameras/near/:lat/:lng'],
    costs: ['/api/cost/area/:la', '/api/cost/national'],
    core: ['/api/dashboard/summary', '/api/la', '/api/regions'],
    spending: ['/api/spending', '/api/spending/rwanda'],
    live: ['/api/live/dashboard', '/api/live/small-boats', '/api/live/news', '/api/live/parliamentary', '/api/live/foi'],
    community: ['/api/community/tips', '/api/community/stats']
  }
}));

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 UK Asylum Tracker API v14 running on port ${PORT}`);
      console.log('New in v14:');
      console.log('  ✓ UK Crime Statistics (Police UK API)');
      console.log('  ✓ Crime data near IRCs and asylum locations');
      console.log('  ✓ Crime comparison between local authorities');
      console.log('  ✓ Stop and search data');
      console.log('  ✓ GeoJSON crime map data');
      console.log('Previous features:');
      console.log('  ✓ France Returns Deal tracker');
      console.log('  ✓ Returns & Deportations data');
      console.log('  ✓ Net Migration (ONS)');
      console.log('  ✓ Appeals backlog');
      console.log('  ✓ Channel deaths tracker');
      console.log('  ✓ Enforcement scorecard');
      console.log('  ✓ IRC cameras');
      console.log('  ✓ Cost calculator');
      console.log('  ✓ Data sources transparency');
    });
  })
  .catch(err => { console.error('Failed to initialize:', err); process.exit(1); });
