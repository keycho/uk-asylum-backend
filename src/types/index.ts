// UK Asylum Dashboard - TypeScript Types
// Mirrors database schema

// =============================================================================
// ENUMS
// =============================================================================

export type DataSourceStatus = 'active' | 'deprecated' | 'error';
export type IngestStatus = 'pending' | 'running' | 'completed' | 'failed';
export type UpdateFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annually' | 'static';
export type SupportType = 'section_95' | 'section_4' | 'section_98';
export type AccommodationType = 'dispersed' | 'initial' | 'hotel' | 'subsistence_only' | 'other';
export type AsylumDecision = 'granted' | 'refused' | 'withdrawn' | 'other';
export type AppealOutcome = 'allowed' | 'dismissed' | 'withdrawn' | 'other';
export type DetentionOutcome = 'released' | 'removed' | 'bailed' | 'granted_leave' | 'other';
export type ReturnType = 'enforced' | 'voluntary' | 'assisted_voluntary';
export type EntryMethod = 'small_boat' | 'lorry' | 'air' | 'other';
export type ExploitationType = 'sexual' | 'labour' | 'criminal' | 'domestic_servitude' | 'other';
export type NrmOutcome = 'positive_conclusive' | 'negative_conclusive' | 'positive_reasonable' | 'pending';

// =============================================================================
// REFERENCE TYPES
// =============================================================================

export interface DataSource {
  id: number;
  code: string;
  name: string;
  description?: string;
  url?: string;
  file_pattern?: string;
  frequency: UpdateFrequency;
  tier: 'A' | 'B' | 'C';
  parser_type: 'ods' | 'html' | 'csv' | 'api' | 'manual' | 'geojson';
  status: DataSourceStatus;
  last_checked?: Date;
  last_updated?: Date;
  content_hash?: string;
  created_at: Date;
  updated_at: Date;
}

export interface IngestRun {
  id: string;
  source_id: number;
  status: IngestStatus;
  started_at: Date;
  completed_at?: Date;
  records_processed: number;
  records_inserted: number;
  records_updated: number;
  error_message?: string;
  content_hash?: string;
  metadata: Record<string, any>;
}

export interface LocalAuthority {
  id: number;
  ons_code: string;
  name: string;
  name_normalized?: string;
  region?: string;
  country?: string;
  population?: number;
  population_year?: number;
  imd_rank?: number;
  imd_score?: number;
  geojson?: GeoJSON.Geometry;
  centroid_lat?: number;
  centroid_lng?: number;
  created_at: Date;
  updated_at: Date;
}

export interface Nationality {
  id: number;
  iso3?: string;
  iso2?: string;
  name: string;
  name_normalized?: string;
  region?: string;
  is_safe_country: boolean;
  created_at: Date;
}

export interface DetentionFacility {
  id: number;
  code: string;
  name: string;
  type?: string;
  operator?: string;
  capacity?: number;
  la_id?: number;
  lat?: number;
  lng?: number;
  opened_date?: Date;
  closed_date?: Date;
  hmip_rating?: string;
  hmip_last_inspection?: Date;
  created_at: Date;
  updated_at: Date;
}

// =============================================================================
// TIER A: LIVE/WEEKLY DATA
// =============================================================================

export interface SmallBoatArrivalDaily {
  id: number;
  date: Date;
  arrivals: number;
  boats?: number;
  people_per_boat?: number;
  source_url?: string;
  scraped_at: Date;
}

export interface SmallBoatArrivalWeekly {
  id: number;
  week_ending: Date;
  year: number;
  week_number?: number;
  arrivals: number;
  boats?: number;
  ytd_arrivals?: number;
  ytd_boats?: number;
  ingest_run_id?: string;
  created_at: Date;
}

export interface SmallBoatNationality {
  id: number;
  period_start: Date;
  period_end: Date;
  period_type: 'year' | 'quarter' | 'month';
  nationality_id?: number;
  nationality_name?: string;
  arrivals: number;
  share_pct?: number;
  ingest_run_id?: string;
  created_at: Date;
}

export interface FrenchPrevention {
  id: number;
  week_ending: Date;
  year?: number;
  attempts_prevented?: number;
  boats_prevented?: number;
  people_prevented?: number;
  ingest_run_id?: string;
  created_at: Date;
}

// =============================================================================
// TIER B: QUARTERLY ASYLUM DATA
// =============================================================================

export interface AsylumClaim {
  id: number;
  quarter_end: Date;
  year: number;
  quarter: number;
  nationality_id?: number;
  nationality_name?: string;
  claims_main_applicant?: number;
  claims_dependants?: number;
  claims_total?: number;
  claims_in_country?: number;
  claims_at_port?: number;
  ingest_run_id?: string;
  created_at: Date;
}

export interface AsylumDecisionRecord {
  id: number;
  quarter_end: Date;
  year: number;
  quarter: number;
  nationality_id?: number;
  nationality_name?: string;
  decisions_total?: number;
  granted_asylum?: number;
  granted_hp?: number;
  granted_dl?: number;
  granted_uasc_leave?: number;
  grants_total?: number;
  refused?: number;
  withdrawn?: number;
  grant_rate_pct?: number;
  ingest_run_id?: string;
  created_at: Date;
}

export interface AsylumBacklog {
  id: number;
  snapshot_date: Date;
  total_awaiting: number;
  awaiting_initial?: number;
  awaiting_further_review?: number;
  awaiting_less_6_months?: number;
  awaiting_6_12_months?: number;
  awaiting_1_3_years?: number;
  awaiting_3_plus_years?: number;
  legacy_cases?: number;
  ingest_run_id?: string;
  created_at: Date;
}

// =============================================================================
// ASYLUM SUPPORT DATA
// =============================================================================

export interface AsylumSupportRegional {
  id: number;
  snapshot_date: Date;
  region: string;
  total_supported: number;
  section_95?: number;
  section_4?: number;
  dispersed?: number;
  initial_accommodation?: number;
  hotel?: number;
  subsistence_only?: number;
  main_applicants?: number;
  dependants?: number;
  ingest_run_id?: string;
  created_at: Date;
}

export interface AsylumSupportLA {
  id: number;
  snapshot_date: Date;
  la_id?: number;
  la_name?: string;
  region?: string;
  
  // Totals
  total_supported: number;
  
  // By support type
  section_95?: number;
  section_4?: number;
  section_98?: number;
  
  // By accommodation type
  dispersed?: number;
  initial_accommodation?: number;
  hotel?: number;
  subsistence_only?: number;
  
  // Demographics
  main_applicants?: number;
  dependants?: number;
  
  // Calculated fields
  per_10k_population?: number;
  national_share_pct?: number;
  hotel_share_pct?: number;
  qoq_change_pct?: number;
  yoy_change_pct?: number;
  
  ingest_run_id?: string;
  created_at: Date;
}

// =============================================================================
// APPEALS & TRIBUNAL
// =============================================================================

export interface AsylumAppeal {
  id: number;
  quarter_end: Date;
  year?: number;
  quarter?: number;
  nationality_id?: number;
  nationality_name?: string;
  appeals_lodged?: number;
  appeals_determined?: number;
  appeals_allowed?: number;
  appeals_dismissed?: number;
  appeals_withdrawn?: number;
  success_rate_pct?: number;
  ingest_run_id?: string;
  created_at: Date;
}

export interface TribunalBacklog {
  id: number;
  snapshot_date: Date;
  outstanding_appeals?: number;
  receipts_ytd?: number;
  disposals_ytd?: number;
  clearance_rate_pct?: number;
  avg_weeks_to_hearing?: number;
  ingest_run_id?: string;
  created_at: Date;
}

// =============================================================================
// DETENTION
// =============================================================================

export interface DetentionPopulation {
  id: number;
  snapshot_date: Date;
  facility_id?: number;
  facility_name?: string;
  population: number;
  capacity?: number;
  occupancy_pct?: number;
  ingest_run_id?: string;
  created_at: Date;
}

export interface DetentionLength {
  id: number;
  quarter_end: Date;
  length_bracket: string;
  bracket_order?: number;
  count?: number;
  share_pct?: number;
  ingest_run_id?: string;
  created_at: Date;
}

export interface DetentionOutcomeRecord {
  id: number;
  quarter_end: Date;
  outcome: DetentionOutcome;
  count?: number;
  share_pct?: number;
  ingest_run_id?: string;
  created_at: Date;
}

export interface DetentionRule35 {
  id: number;
  quarter_end: Date;
  facility_id?: number;
  reports_made?: number;
  released_following?: number;
  ingest_run_id?: string;
  created_at: Date;
}

// =============================================================================
// RETURNS & REMOVALS
// =============================================================================

export interface Return {
  id: number;
  quarter_end: Date;
  year?: number;
  quarter?: number;
  nationality_id?: number;
  nationality_name?: string;
  return_type: ReturnType;
  count?: number;
  ingest_run_id?: string;
  created_at: Date;
}

export interface FnoDeportation {
  id: number;
  quarter_end: Date;
  nationality_id?: number;
  nationality_name?: string;
  offence_type?: string;
  count?: number;
  ingest_run_id?: string;
  created_at: Date;
}

// =============================================================================
// UASC
// =============================================================================

export interface UascClaim {
  id: number;
  quarter_end: Date;
  nationality_id?: number;
  nationality_name?: string;
  claims?: number;
  age_under_14?: number;
  age_14_15?: number;
  age_16_17?: number;
  male?: number;
  female?: number;
  ingest_run_id?: string;
  created_at: Date;
}

export interface UascLA {
  id: number;
  snapshot_date: Date;
  la_id?: number;
  la_name?: string;
  uasc_count?: number;
  care_leavers?: number;
  national_transfer_in?: number;
  national_transfer_out?: number;
  per_10k_child_population?: number;
  ingest_run_id?: string;
  created_at: Date;
}

// =============================================================================
// MODERN SLAVERY / NRM
// =============================================================================

export interface NrmReferral {
  id: number;
  quarter_end: Date;
  nationality_id?: number;
  nationality_name?: string;
  exploitation: ExploitationType;
  referrals?: number;
  referral_source?: string;
  ingest_run_id?: string;
  created_at: Date;
}

export interface NrmDecision {
  id: number;
  quarter_end: Date;
  nationality_id?: number;
  nationality_name?: string;
  outcome: NrmOutcome;
  count?: number;
  ingest_run_id?: string;
  created_at: Date;
}

// =============================================================================
// RESETTLEMENT
// =============================================================================

export interface Resettlement {
  id: number;
  quarter_end: Date;
  scheme: 'ACRS' | 'ARAP' | 'UKRS' | 'VPRS';
  arrivals?: number;
  total_since_start?: number;
  ingest_run_id?: string;
  created_at: Date;
}

export interface ResettlementLA {
  id: number;
  snapshot_date: Date;
  la_id?: number;
  la_name?: string;
  scheme?: string;
  placements?: number;
  ingest_run_id?: string;
  created_at: Date;
}

export interface UkraineArrival {
  id: number;
  snapshot_date: Date;
  visa_applications?: number;
  visas_issued?: number;
  arrivals?: number;
  ingest_run_id?: string;
  created_at: Date;
}

export interface UkraineLA {
  id: number;
  snapshot_date: Date;
  la_id?: number;
  la_name?: string;
  arrivals?: number;
  currently_sponsored?: number;
  rematches?: number;
  homelessness_presentations?: number;
  ingest_run_id?: string;
  created_at: Date;
}

export interface FamilyReunion {
  id: number;
  quarter_end: Date;
  nationality_id?: number;
  nationality_name?: string;
  applications?: number;
  grants?: number;
  refusals?: number;
  ingest_run_id?: string;
  created_at: Date;
}

// =============================================================================
// SPENDING
// =============================================================================

export interface SpendingAnnual {
  id: number;
  financial_year: string;
  fy_start?: Date;
  fy_end?: Date;
  total_spend_millions?: number;
  accommodation_spend?: number;
  hotel_spend?: number;
  dispersed_spend?: number;
  initial_accommodation_spend?: number;
  detention_removals_spend?: number;
  appeals_tribunal_spend?: number;
  legal_aid_spend?: number;
  uasc_grants_spend?: number;
  other_spend?: number;
  avg_supported_population?: number;
  cost_per_person?: number;
  cost_per_decision?: number;
  source?: string;
  ingest_run_id?: string;
  created_at: Date;
}

export interface HotelCost {
  id: number;
  snapshot_date: Date;
  hotel_population?: number;
  cost_per_night?: number;
  dispersed_cost_per_night?: number;
  premium_multiple?: number;
  annual_hotel_cost_millions?: number;
  potential_saving_millions?: number;
  source?: string;
  ingest_run_id?: string;
  created_at: Date;
}

// =============================================================================
// COMPUTED / ANALYTICS
// =============================================================================

export interface PressureIndex {
  id: number;
  snapshot_date: Date;
  la_id?: number;
  la_name?: string;
  per_capita_score?: number;
  hotel_share_score?: number;
  growth_score?: number;
  deprivation_score?: number;
  pressure_index?: number;
  pressure_rank?: number;
  pressure_quintile?: number;
  created_at: Date;
}

export interface AutoInsight {
  id: number;
  generated_date: Date;
  insight_type: 'la_outlier' | 'trend' | 'milestone' | 'comparison' | 'alert';
  subject?: string;
  metric?: string;
  headline: string;
  detail?: string;
  magnitude?: number;
  expires_at?: Date;
  created_at: Date;
}

// =============================================================================
// API RESPONSE TYPES
// =============================================================================

export interface DashboardSummary {
  total_supported: number;
  total_spend_millions: number;
  backlog_total: number;
  hotel_population: number;
  hotel_share_pct: number;
  ytd_small_boat_arrivals: number;
  ytd_decisions: number;
  avg_grant_rate_pct: number;
  last_updated: Date;
}

export interface LADetailResponse {
  la: LocalAuthority;
  current_support: AsylumSupportLA;
  historical_support: AsylumSupportLA[];
  pressure_index?: PressureIndex;
  uasc?: UascLA;
  resettlement?: ResettlementLA[];
  ukraine?: UkraineLA;
  insights: AutoInsight[];
}

export interface NationalityDetailResponse {
  nationality: Nationality;
  claims: AsylumClaim[];
  decisions: AsylumDecisionRecord[];
  appeals: AsylumAppeal[];
  returns: Return[];
  small_boat_arrivals: SmallBoatNationality[];
  current_grant_rate_pct?: number;
  appeals_success_rate_pct?: number;
}

export interface TimeSeriesPoint {
  date: Date;
  value: number;
  label?: string;
}

export interface SpendingBreakdown {
  category: string;
  amount_millions: number;
  share_pct: number;
  color?: string;
}
