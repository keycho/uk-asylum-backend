// Database connection and query helpers
import { Pool, PoolClient, QueryResult } from 'pg';
import { createHash } from 'crypto';

// =============================================================================
// DATABASE POOL
// =============================================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export { pool };

// =============================================================================
// QUERY HELPERS
// =============================================================================

export async function query(
  text: string,
  params?: any[]
): Promise<QueryResult<any>> {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  
  if (process.env.LOG_QUERIES === 'true') {
    console.log('Executed query', { text: text.substring(0, 100), duration, rows: res.rowCount });
  }
  
  return res;
}

export async function getOne<T = any>(
  text: string,
  params?: any[]
): Promise<T | null> {
  const res = await query(text, params);
  return res.rows[0] || null;
}

export async function getMany<T = any>(
  text: string,
  params?: any[]
): Promise<T[]> {
  const res = await query(text, params);
  return res.rows;
}

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// =============================================================================
// UPSERT HELPERS
// =============================================================================

export async function upsertOne(
  table: string,
  data: Record<string, any>,
  conflictColumns: string[],
  updateColumns?: string[]
): Promise<number> {
  const columns = Object.keys(data);
  const values = Object.values(data);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  
  const conflictClause = conflictColumns.join(', ');
  const updateClause = (updateColumns || columns.filter(c => !conflictColumns.includes(c)))
    .map(c => `${c} = EXCLUDED.${c}`)
    .join(', ');
  
  const sql = `
    INSERT INTO ${table} (${columns.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT (${conflictClause})
    DO UPDATE SET ${updateClause}
    RETURNING id
  `;
  
  const res = await query(sql, values);
  return res.rows[0]?.id;
}

export async function bulkUpsert(
  table: string,
  rows: Record<string, any>[],
  conflictColumns: string[],
  updateColumns?: string[]
): Promise<{ inserted: number; updated: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  
  const columns = Object.keys(rows[0]);
  const updates = updateColumns || columns.filter(c => !conflictColumns.includes(c));
  
  let inserted = 0;
  
  // Batch in chunks of 100
  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    
    // Build multi-row VALUES clause
    const valuesClauses: string[] = [];
    const allValues: any[] = [];
    let paramIndex = 1;
    
    for (const row of chunk) {
      const rowPlaceholders = columns.map(() => `$${paramIndex++}`);
      valuesClauses.push(`(${rowPlaceholders.join(', ')})`);
      columns.forEach(col => allValues.push(row[col]));
    }
    
    const sql = `
      INSERT INTO ${table} (${columns.join(', ')})
      VALUES ${valuesClauses.join(', ')}
      ON CONFLICT (${conflictColumns.join(', ')})
      DO UPDATE SET ${updates.map(c => `${c} = EXCLUDED.${c}`).join(', ')}
    `;
    
    const res = await query(sql, allValues);
    inserted += res.rowCount || 0;
  }
  
  return { inserted, updated: 0 };
}

// =============================================================================
// HASH HELPERS
// =============================================================================

export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

// =============================================================================
// DATE HELPERS
// =============================================================================

export function toQuarterEnd(year: number, quarter: number): Date {
  const month = quarter * 3;
  return new Date(year, month, 0); // Last day of quarter
}

export function parseUKDate(dateStr: string): Date | null {
  // Handle various UK date formats
  const formats = [
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, // DD/MM/YYYY
    /^(\d{4})-(\d{2})-(\d{2})$/, // YYYY-MM-DD
  ];
  
  for (const format of formats) {
    const match = dateStr.match(format);
    if (match) {
      if (format === formats[0]) {
        return new Date(parseInt(match[3]), parseInt(match[2]) - 1, parseInt(match[1]));
      } else if (format === formats[1]) {
        return new Date(match[0]);
      }
    }
  }
  
  // Try native parsing as fallback
  const parsed = new Date(dateStr);
  return isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDateISO(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function getQuarterFromDate(date: Date): { year: number; quarter: number } {
  const year = date.getFullYear();
  const month = date.getMonth();
  const quarter = Math.floor(month / 3) + 1;
  return { year, quarter };
}

// =============================================================================
// NORMALIZATION HELPERS
// =============================================================================

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[^a-z0-9\s]/g, '') // Remove special chars
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeLAName(name: string): string {
  return normalizeText(name)
    .replace(/\b(city|county|borough|district|council)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// =============================================================================
// LOGGING
// =============================================================================

export function log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, any>) {
  const timestamp = new Date().toISOString();
  const logObj = { timestamp, level, message, ...meta };
  
  if (level === 'error') {
    console.error(JSON.stringify(logObj));
  } else {
    console.log(JSON.stringify(logObj));
  }
}
