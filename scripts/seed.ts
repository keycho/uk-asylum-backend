// Seed Script - Populate reference data
// Run with: npm run db:seed

import { query, log } from '../src/lib/db';

async function seedLocalAuthorities(): Promise<void> {
  log('info', 'Seeding local authorities...');
  
  // Core England LAs (top asylum support areas)
  const las = [
    { ons_code: 'E08000025', name: 'Birmingham', region: 'West Midlands', population: 1157603 },
    { ons_code: 'S12000049', name: 'Glasgow City', region: 'Scotland', population: 635640, country: 'Scotland' },
    { ons_code: 'E09000017', name: 'Hillingdon', region: 'London', population: 309014 },
    { ons_code: 'E08000003', name: 'Manchester', region: 'North West', population: 568996 },
    { ons_code: 'E08000012', name: 'Liverpool', region: 'North West', population: 496784 },
    { ons_code: 'E08000035', name: 'Leeds', region: 'Yorkshire and The Humber', population: 812000 },
    { ons_code: 'E08000021', name: 'Newcastle upon Tyne', region: 'North East', population: 307220 },
    { ons_code: 'E06000018', name: 'Nottingham', region: 'East Midlands', population: 338590 },
    { ons_code: 'E08000016', name: 'Barnsley', region: 'Yorkshire and The Humber', population: 247120 },
    { ons_code: 'E08000019', name: 'Sheffield', region: 'Yorkshire and The Humber', population: 589860 },
    { ons_code: 'E08000032', name: 'Bradford', region: 'Yorkshire and The Humber', population: 546400 },
    { ons_code: 'E06000008', name: 'Blackburn with Darwen', region: 'North West', population: 150827 },
    { ons_code: 'E08000009', name: 'Trafford', region: 'North West', population: 237354 },
    { ons_code: 'E06000015', name: 'Derby', region: 'East Midlands', population: 261500 },
    { ons_code: 'E06000016', name: 'Leicester', region: 'East Midlands', population: 368600 },
    { ons_code: 'E08000026', name: 'Coventry', region: 'West Midlands', population: 379387 },
    { ons_code: 'E08000027', name: 'Dudley', region: 'West Midlands', population: 328672 },
    { ons_code: 'E08000028', name: 'Sandwell', region: 'West Midlands', population: 341900 },
    { ons_code: 'E08000029', name: 'Solihull', region: 'West Midlands', population: 217610 },
    { ons_code: 'E08000030', name: 'Walsall', region: 'West Midlands', population: 288000 },
    { ons_code: 'E08000031', name: 'Wolverhampton', region: 'West Midlands', population: 264407 },
    { ons_code: 'E06000023', name: 'Bristol, City of', region: 'South West', population: 472400 },
    { ons_code: 'E06000024', name: 'Brighton and Hove', region: 'South East', population: 292700 },
    { ons_code: 'E06000025', name: 'South Gloucestershire', region: 'South West', population: 285090 },
    { ons_code: 'E06000043', name: 'Brighton and Hove', region: 'South East', population: 292700 },
    { ons_code: 'E09000001', name: 'City of London', region: 'London', population: 8600 },
    { ons_code: 'E09000002', name: 'Barking and Dagenham', region: 'London', population: 218900 },
    { ons_code: 'E09000003', name: 'Barnet', region: 'London', population: 410700 },
    { ons_code: 'E09000004', name: 'Bexley', region: 'London', population: 252100 },
    { ons_code: 'E09000005', name: 'Brent', region: 'London', population: 339800 },
    { ons_code: 'E09000006', name: 'Bromley', region: 'London', population: 337200 },
    { ons_code: 'E09000007', name: 'Camden', region: 'London', population: 270000 },
    { ons_code: 'E09000008', name: 'Croydon', region: 'London', population: 396100 },
    { ons_code: 'E09000009', name: 'Ealing', region: 'London', population: 367100 },
    { ons_code: 'E09000010', name: 'Enfield', region: 'London', population: 340500 },
    { ons_code: 'E09000011', name: 'Greenwich', region: 'London', population: 291300 },
    { ons_code: 'E09000012', name: 'Hackney', region: 'London', population: 289900 },
    { ons_code: 'E09000013', name: 'Hammersmith and Fulham', region: 'London', population: 191200 },
    { ons_code: 'E09000014', name: 'Haringey', region: 'London', population: 272900 },
    { ons_code: 'E09000015', name: 'Harrow', region: 'London', population: 262200 },
    { ons_code: 'E09000016', name: 'Havering', region: 'London', population: 265200 },
    { ons_code: 'E09000018', name: 'Hounslow', region: 'London', population: 288200 },
    { ons_code: 'E09000019', name: 'Islington', region: 'London', population: 245800 },
    { ons_code: 'E09000020', name: 'Kensington and Chelsea', region: 'London', population: 144900 },
    { ons_code: 'E09000021', name: 'Kingston upon Thames', region: 'London', population: 179500 },
    { ons_code: 'E09000022', name: 'Lambeth', region: 'London', population: 336300 },
    { ons_code: 'E09000023', name: 'Lewisham', region: 'London', population: 318800 },
    { ons_code: 'E09000024', name: 'Merton', region: 'London', population: 216700 },
    { ons_code: 'E09000025', name: 'Newham', region: 'London', population: 387900 },
    { ons_code: 'E09000026', name: 'Redbridge', region: 'London', population: 313200 },
    { ons_code: 'E09000027', name: 'Richmond upon Thames', region: 'London', population: 201700 },
    { ons_code: 'E09000028', name: 'Southwark', region: 'London', population: 331100 },
    { ons_code: 'E09000029', name: 'Sutton', region: 'London', population: 211900 },
    { ons_code: 'E09000030', name: 'Tower Hamlets', region: 'London', population: 331100 },
    { ons_code: 'E09000031', name: 'Waltham Forest', region: 'London', population: 286400 },
    { ons_code: 'E09000032', name: 'Wandsworth', region: 'London', population: 335700 },
    { ons_code: 'E09000033', name: 'Westminster', region: 'London', population: 269800 },
    { ons_code: 'S12000033', name: 'Aberdeen City', region: 'Scotland', population: 228670, country: 'Scotland' },
    { ons_code: 'S12000034', name: 'Aberdeenshire', region: 'Scotland', population: 264283, country: 'Scotland' },
    { ons_code: 'S12000041', name: 'Angus', region: 'Scotland', population: 116220, country: 'Scotland' },
    { ons_code: 'S12000036', name: 'City of Edinburgh', region: 'Scotland', population: 536775, country: 'Scotland' },
    { ons_code: 'W06000015', name: 'Cardiff', region: 'Wales', population: 369202, country: 'Wales' },
    { ons_code: 'W06000022', name: 'Newport', region: 'Wales', population: 159600, country: 'Wales' },
    { ons_code: 'W06000011', name: 'Swansea', region: 'Wales', population: 248100, country: 'Wales' },
    { ons_code: 'N09000003', name: 'Belfast', region: 'Northern Ireland', population: 343542, country: 'Northern Ireland' },
  ];

  for (const la of las) {
    await query(
      `INSERT INTO local_authorities (ons_code, name, name_normalized, region, country, population, population_year)
       VALUES ($1, $2, $3, $4, $5, $6, 2023)
       ON CONFLICT (ons_code) DO UPDATE SET
         name = EXCLUDED.name,
         region = EXCLUDED.region,
         population = EXCLUDED.population`,
      [la.ons_code, la.name, la.name.toLowerCase(), la.region, la.country || 'England', la.population]
    );
  }
  
  log('info', `Seeded ${las.length} local authorities`);
}

async function seedNationalities(): Promise<void> {
  log('info', 'Seeding nationalities...');
  
  const nationalities = [
    { iso3: 'AFG', iso2: 'AF', name: 'Afghan', region: 'South Asia' },
    { iso3: 'ALB', iso2: 'AL', name: 'Albanian', region: 'Europe', is_safe: true },
    { iso3: 'DZA', iso2: 'DZ', name: 'Algerian', region: 'North Africa' },
    { iso3: 'BGD', iso2: 'BD', name: 'Bangladeshi', region: 'South Asia' },
    { iso3: 'CHN', iso2: 'CN', name: 'Chinese', region: 'East Asia' },
    { iso3: 'COD', iso2: 'CD', name: 'Congolese (DRC)', region: 'Sub-Saharan Africa' },
    { iso3: 'ERI', iso2: 'ER', name: 'Eritrean', region: 'East Africa' },
    { iso3: 'ETH', iso2: 'ET', name: 'Ethiopian', region: 'East Africa' },
    { iso3: 'IND', iso2: 'IN', name: 'Indian', region: 'South Asia' },
    { iso3: 'IRN', iso2: 'IR', name: 'Iranian', region: 'Middle East' },
    { iso3: 'IRQ', iso2: 'IQ', name: 'Iraqi', region: 'Middle East' },
    { iso3: 'NGA', iso2: 'NG', name: 'Nigerian', region: 'West Africa' },
    { iso3: 'PAK', iso2: 'PK', name: 'Pakistani', region: 'South Asia' },
    { iso3: 'SOM', iso2: 'SO', name: 'Somali', region: 'East Africa' },
    { iso3: 'LKA', iso2: 'LK', name: 'Sri Lankan', region: 'South Asia' },
    { iso3: 'SDN', iso2: 'SD', name: 'Sudanese', region: 'North Africa' },
    { iso3: 'SYR', iso2: 'SY', name: 'Syrian', region: 'Middle East' },
    { iso3: 'TUR', iso2: 'TR', name: 'Turkish', region: 'Middle East' },
    { iso3: 'VNM', iso2: 'VN', name: 'Vietnamese', region: 'Southeast Asia' },
    { iso3: 'YEM', iso2: 'YE', name: 'Yemeni', region: 'Middle East' },
    { iso3: 'ZWE', iso2: 'ZW', name: 'Zimbabwean', region: 'Southern Africa' },
    { iso3: 'UKR', iso2: 'UA', name: 'Ukrainian', region: 'Europe' },
    { iso3: 'GEO', iso2: 'GE', name: 'Georgian', region: 'Caucasus', is_safe: true },
    { iso3: 'MDA', iso2: 'MD', name: 'Moldovan', region: 'Europe' },
    { iso3: 'EGY', iso2: 'EG', name: 'Egyptian', region: 'North Africa' },
    { iso3: 'LBY', iso2: 'LY', name: 'Libyan', region: 'North Africa' },
    { iso3: 'TCD', iso2: 'TD', name: 'Chadian', region: 'Central Africa' },
    { iso3: 'CMR', iso2: 'CM', name: 'Cameroonian', region: 'Central Africa' },
    { iso3: 'GMB', iso2: 'GM', name: 'Gambian', region: 'West Africa' },
    { iso3: 'SLE', iso2: 'SL', name: 'Sierra Leonean', region: 'West Africa' },
    { iso3: 'GHA', iso2: 'GH', name: 'Ghanaian', region: 'West Africa' },
    { iso3: 'SEN', iso2: 'SN', name: 'Senegalese', region: 'West Africa' },
    { iso3: 'MLI', iso2: 'ML', name: 'Malian', region: 'West Africa' },
    { iso3: 'GIN', iso2: 'GN', name: 'Guinean', region: 'West Africa' },
    { iso3: 'CIV', iso2: 'CI', name: 'Ivorian', region: 'West Africa' },
    { iso3: 'KWT', iso2: 'KW', name: 'Kuwaiti', region: 'Middle East' },
    { iso3: 'JOR', iso2: 'JO', name: 'Jordanian', region: 'Middle East' },
    { iso3: 'LBN', iso2: 'LB', name: 'Lebanese', region: 'Middle East' },
    { iso3: 'PSE', iso2: 'PS', name: 'Palestinian', region: 'Middle East' },
    { iso3: 'MMR', iso2: 'MM', name: 'Myanmar (Burmese)', region: 'Southeast Asia' },
  ];

  for (const nat of nationalities) {
    await query(
      `INSERT INTO nationalities (iso3, iso2, name, name_normalized, region, is_safe_country)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (iso3) DO UPDATE SET
         name = EXCLUDED.name,
         region = EXCLUDED.region`,
      [nat.iso3, nat.iso2, nat.name, nat.name.toLowerCase(), nat.region, nat.is_safe || false]
    );
  }
  
  log('info', `Seeded ${nationalities.length} nationalities`);
}

async function seedSpendingData(): Promise<void> {
  log('info', 'Seeding spending data...');
  
  // NAO and Home Office data
  const spending = [
    { fy: '2019-20', total: 739, hotel: 100, accommodation: 500, cost_per_person: 15000 },
    { fy: '2020-21', total: 976, hotel: 200, accommodation: 700, cost_per_person: 18000 },
    { fy: '2021-22', total: 1530, hotel: 500, accommodation: 1100, cost_per_person: 25000 },
    { fy: '2022-23', total: 3068, hotel: 1200, accommodation: 2400, cost_per_person: 32000 },
    { fy: '2023-24', total: 4319, hotel: 1800, accommodation: 3200, cost_per_person: 37000 },
    { fy: '2024-25', total: 4000, hotel: 2100, accommodation: 3400, cost_per_person: 36000 },
  ];

  for (const s of spending) {
    await query(
      `INSERT INTO spending_annual (financial_year, total_spend_millions, hotel_spend, accommodation_spend, cost_per_person, source)
       VALUES ($1, $2, $3, $4, $5, 'NAO/Home Office')
       ON CONFLICT (financial_year) DO UPDATE SET
         total_spend_millions = EXCLUDED.total_spend_millions,
         hotel_spend = EXCLUDED.hotel_spend`,
      [s.fy, s.total, s.hotel, s.accommodation, s.cost_per_person]
    );
  }
  
  log('info', `Seeded ${spending.length} spending records`);
}

async function seedHotelCosts(): Promise<void> {
  log('info', 'Seeding hotel cost benchmarks...');
  
  await query(
    `INSERT INTO hotel_costs (snapshot_date, hotel_population, cost_per_night, dispersed_cost_per_night, premium_multiple, source)
     VALUES (CURRENT_DATE, 36273, 140, 18, 7.8, 'NAO Analysis Dec 2025')
     ON CONFLICT DO NOTHING`
  );
  
  log('info', 'Seeded hotel costs');
}

async function seedSampleAsylumData(): Promise<void> {
  log('info', 'Seeding sample asylum data for testing...');
  
  // Sample LA support data
  const sampleSupport = [
    { la_name: 'Glasgow City', total: 3844, hotel: 1200, dispersed: 2100, section_95: 3000, section_4: 800 },
    { la_name: 'Birmingham', total: 2755, hotel: 900, dispersed: 1500, section_95: 2200, section_4: 500 },
    { la_name: 'Hillingdon', total: 2481, hotel: 2100, dispersed: 200, section_95: 2000, section_4: 400 },
    { la_name: 'Manchester', total: 2100, hotel: 600, dispersed: 1200, section_95: 1800, section_4: 300 },
    { la_name: 'Liverpool', total: 1850, hotel: 400, dispersed: 1200, section_95: 1500, section_4: 350 },
    { la_name: 'Leeds', total: 1720, hotel: 300, dispersed: 1100, section_95: 1400, section_4: 320 },
    { la_name: 'Sheffield', total: 1450, hotel: 250, dispersed: 900, section_95: 1200, section_4: 250 },
    { la_name: 'Newcastle upon Tyne', total: 1320, hotel: 200, dispersed: 850, section_95: 1100, section_4: 220 },
  ];

  for (const s of sampleSupport) {
    // Get LA ID
    const la = await query(`SELECT id FROM local_authorities WHERE name = $1`, [s.la_name]);
    if (la.rows[0]) {
      await query(
        `INSERT INTO asylum_support_la (
          snapshot_date, la_id, la_name, total_supported, hotel, dispersed, section_95, section_4
        ) VALUES (CURRENT_DATE - INTERVAL '30 days', $1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING`,
        [la.rows[0].id, s.la_name, s.total, s.hotel, s.dispersed, s.section_95, s.section_4]
      );
    }
  }

  // Sample backlog data
  await query(
    `INSERT INTO asylum_backlog (snapshot_date, total_awaiting, awaiting_less_6_months, awaiting_6_12_months, awaiting_1_3_years, awaiting_3_plus_years)
     VALUES 
       (CURRENT_DATE - INTERVAL '90 days', 68000, 15000, 18000, 25000, 10000),
       (CURRENT_DATE - INTERVAL '60 days', 65000, 14000, 17000, 24000, 10000),
       (CURRENT_DATE - INTERVAL '30 days', 62200, 13000, 16000, 23000, 10200)
     ON CONFLICT DO NOTHING`
  );

  log('info', 'Seeded sample asylum data');
}

async function main(): Promise<void> {
  log('info', 'Starting database seed...');
  
  try {
    await seedLocalAuthorities();
    await seedNationalities();
    await seedSpendingData();
    await seedHotelCosts();
    await seedSampleAsylumData();
    
    log('info', 'Database seed complete!');
  } catch (error) {
    log('error', 'Seed failed', { error: String(error) });
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
