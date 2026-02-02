// Run Ingestion Script
// Usage: tsx scripts/run-ingest.ts [SOURCE_CODE | --tier A|B|C | --all]

import { runIngestor, runAllIngestors } from '../src/lib/ingest';
import { log } from '../src/lib/db';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help') {
    console.log(`
UK Asylum Dashboard - Ingestion Runner

Usage:
  tsx scripts/run-ingest.ts <SOURCE_CODE>    Run single ingestor
  tsx scripts/run-ingest.ts --tier A         Run all Tier A (daily/weekly) sources
  tsx scripts/run-ingest.ts --tier B         Run all Tier B (quarterly) sources
  tsx scripts/run-ingest.ts --tier C         Run all Tier C (annual) sources
  tsx scripts/run-ingest.ts --all            Run all sources

Available source codes:
  Tier A (Live/Weekly):
    SBA_DAILY     - Small Boat Arrivals Daily (HTML scrape)
    SBA_WEEKLY    - Small Boat Time Series Weekly (ODS)
    FRENCH_PREV   - French Prevention Activity (ODS)
    UKRAINE       - Homes for Ukraine (CSV)

  Tier B (Quarterly):
    ASY_D01       - Asylum Claims by Nationality
    ASY_D02       - Asylum Decisions by Nationality
    ASY_D03       - Asylum Backlog
    ASY_D06       - Age Disputes
    ASY_D07       - UASC Claims
    ASY_D09       - Asylum Support Regional
    ASY_D11       - Asylum Support by LA
    HMCTS_FIA     - Asylum Appeals
    DET_D01-04    - Detention data
    RET_D01-02    - Returns data
    IRR_D02       - Irregular Entry by Nationality
    NRM_STATS     - Modern Slavery NRM
    RES_D01-02    - Resettlement Schemes
    FAM_D01       - Family Reunion

  Tier C (Annual):
    NAO_ASYLUM    - NAO Asylum Spending Analysis
    HO_ACCOUNTS   - Home Office Annual Accounts
    ONS_POP       - LA Population Estimates
    ONS_GEO       - LA Boundaries GeoJSON
    IMD_2019      - Index of Multiple Deprivation

Examples:
  tsx scripts/run-ingest.ts SBA_DAILY
  tsx scripts/run-ingest.ts --tier A
  tsx scripts/run-ingest.ts --all
    `);
    process.exit(0);
  }

  try {
    if (args[0] === '--tier') {
      const tier = args[1] as 'A' | 'B' | 'C';
      if (!['A', 'B', 'C'].includes(tier)) {
        console.error('Invalid tier. Use A, B, or C');
        process.exit(1);
      }
      
      log('info', `Running all Tier ${tier} ingestors...`);
      const runs = await runAllIngestors(tier);
      
      console.log(`\nCompleted ${runs.length} ingestion runs:`);
      for (const run of runs) {
        console.log(`  ${run.status}: processed=${run.records_processed}, inserted=${run.records_inserted}`);
      }
      
    } else if (args[0] === '--all') {
      log('info', 'Running all ingestors...');
      const runs = await runAllIngestors();
      
      console.log(`\nCompleted ${runs.length} ingestion runs`);
      
    } else {
      const sourceCode = args[0];
      log('info', `Running ingestor: ${sourceCode}`);
      
      const run = await runIngestor(sourceCode);
      
      console.log(`\nIngestion complete:`);
      console.log(`  Status: ${run.status}`);
      console.log(`  Records processed: ${run.records_processed}`);
      console.log(`  Records inserted: ${run.records_inserted}`);
      console.log(`  Records updated: ${run.records_updated}`);
      
      if (run.error_message) {
        console.error(`  Error: ${run.error_message}`);
      }
    }
    
    process.exit(0);
    
  } catch (error) {
    log('error', 'Ingestion failed', { error: String(error) });
    console.error('Ingestion failed:', error);
    process.exit(1);
  }
}

main();
