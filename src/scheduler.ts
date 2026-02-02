// Cron Scheduler for Automated Ingestion
// Run as a separate process: tsx src/scheduler.ts

import cron from 'node-cron';
import { runIngestor, INGESTION_SCHEDULE, runAllIngestors } from './lib/ingest';
import { log } from './lib/db';

// Track running jobs to prevent overlaps
const runningJobs = new Set<string>();

async function runJob(sourceCode: string): Promise<void> {
  if (runningJobs.has(sourceCode)) {
    log('info', `Skipping ${sourceCode} - already running`);
    return;
  }
  
  runningJobs.add(sourceCode);
  
  try {
    log('info', `Scheduled job starting: ${sourceCode}`);
    await runIngestor(sourceCode);
    log('info', `Scheduled job completed: ${sourceCode}`);
  } catch (error) {
    log('error', `Scheduled job failed: ${sourceCode}`, { error: String(error) });
  } finally {
    runningJobs.delete(sourceCode);
  }
}

function startScheduler(): void {
  log('info', 'Starting ingestion scheduler...');
  
  // Register all scheduled jobs
  for (const config of INGESTION_SCHEDULE) {
    if (!config.enabled) {
      log('info', `Skipping disabled job: ${config.sourceCode}`);
      continue;
    }
    
    if (!cron.validate(config.cron)) {
      log('error', `Invalid cron expression for ${config.sourceCode}: ${config.cron}`);
      continue;
    }
    
    cron.schedule(config.cron, () => {
      runJob(config.sourceCode);
    }, {
      timezone: 'Europe/London'
    });
    
    log('info', `Scheduled: ${config.sourceCode} @ ${config.cron}`);
  }
  
  // Also schedule insight generation daily at 6am
  cron.schedule('0 6 * * *', async () => {
    log('info', 'Running daily insights generation');
    // Insights generation placeholder
    console.log('Insights generation would run here');
  }, {
    timezone: 'Europe/London'
  });
  
  log('info', 'Scheduler started');
  
  // Keep process alive
  process.on('SIGINT', () => {
    log('info', 'Scheduler shutting down...');
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    log('info', 'Scheduler shutting down...');
    process.exit(0);
  });
}

// Run initial ingestion on startup if requested
if (process.env.RUN_INITIAL_INGEST === 'true') {
  log('info', 'Running initial Tier A ingestion...');
  runAllIngestors('A')
    .then(() => log('info', 'Initial ingestion complete'))
    .catch((err: any) => log('error', 'Initial ingestion failed', { error: String(err) }));
}

startScheduler();
