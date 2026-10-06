/** Legal group: judge and court lookup through JudgeFinder's public JSON API (read only). */
import { z } from "zod";
import { clip, fetchJson, qs, UpstreamError } from "../lib/http.js";
import { defineTool, ToolInputError, type ToolContext } from "./types.js";

export const LEGAL_DISCLAIMER =
  "Informational only, not legal advice and not a basis for judge-shopping or any decision about a case. Data comes from public court records and may be incomplete or lag the courts. Verify with the court before relying on it.";

const SOURCE = "JudgeFinder (https://judgefinder.vercel.app)";

function jfBase(ctx: ToolContext): string {
  return (ctx.env.get("JUDGEFINDER_BASE_URL") ?? "https://judgefinder.vercel.app").replace(/\/$/, "");
}

async function jf<T>(ctx: ToolContext, path: string, ttl = 300): Promise<T | null> {
  try {
    return await fetchJson<T>(`${jfBase(ctx)}${path}`, { service: "JudgeFinder", ttlSeconds: ttl, nullOn: [404], fetchImpl: ctx.fetchImpl });
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 400) throw new ToolInputError("JudgeFinder rejected the request; check the slug or id.");
    throw err;
  }
}

interface SearchResp {
  results?: { id: string; type?: string; title: string; subtitle?: string; description?: string; url?: string }[];
  total_count?: number;
  has_more?: boolean;
}

interface Court {
  id: string;
  name: string;
  type?: string;
  jurisdiction?: string;
  county?: string | null;
  city?: string | null;
  state?: string | null;
  address?: string | null;
  phone?: string | null;
  website?: string | null;
  judge_count?: number;
}

const shapeCourt = (c: Court) => ({
  id: c.id,
  name: c.name,
  type: c.type ?? null,
  state: c.state ?? c.jurisdiction ?? null,
  county: c.county && c.county !== "Unknown" ? c.county : null,
  city: c.city ?? null,
  address: c.address ?? null,
  phone: c.phone ?? null,
  website: c.website ?? null,
  judge_count: c.judge_count ?? null,
});

export const legalTools = [
  defineTool({
    group: "legal",
    name: "legal_search_judges",
    title: "Search judges",
    description:
      "Search US federal and state judges by name. Returns name, court, jurisdiction, case count and the profile slug to use with legal_get_judge.",
    input: {
      query: z.string().trim().min(2).max(120).describe("Judge name or partial name, e.g. 'smith'."),
      state: z.string().trim().length(2).optional().describe("Two-letter jurisdiction filter, e.g. CA."),
      limit: z.number().int().min(1).max(20).default(8),
    },
    async run({ query, state, limit }, ctx) {
      const d = await jf<SearchResp>(ctx, `/api/judges/search${qs({ q: query, limit, jurisdiction: state?.toUpperCase() })}`, 300);
      const results = (d?.results ?? []).slice(0, limit).map((r) => ({
        id: r.id,
        name: r.title,
        court: r.subtitle ?? null,
        summary: r.description ?? null,
        slug: r.url?.replace(/^\/judges\//, "") ?? null,
        profile_url: r.url ? `${jfBase(ctx)}${r.url}` : null,
      }));
      return { source: SOURCE, query, total_matches: d?.total_count ?? results.length, has_more: d?.has_more ?? false, results, disclaimer: LEGAL_DISCLAIMER };
    },
  }),

  defineTool({
    group: "legal",
    name: "legal_get_judge",
    title: "Get a judge profile",
    description:
      "Profile for one judge by slug (from legal_search_judges): court, jurisdiction, appointment date, number of public cases analyzed, and practice-area activity summary.",
    input: { slug: z.string().trim().min(2).max(160).regex(/^[a-z0-9-]+$/, "Lowercase letters, digits and dashes only.") },
    async run({ slug }, ctx) {
      const d = await jf<{
        judge?: Record<string, unknown> & {
          id?: string;
          name: string;
          slug: string;
          court_name?: string;
          court_id?: string;
          jurisdiction?: string;
          appointed_date?: string | null;
          total_cases?: number;
          is_verified?: boolean;
          data_source?: string;
          case_analytics?: {
            summary?: { total_cases_analyzed?: number; most_recent_case_date?: string; average_case_duration_days?: number };
            practice_areas?: Record<string, { case_count?: number; recent_case_count?: number; avg_case_duration_days?: number }>;
          };
        };
        alternatives?: { slug?: string; name?: string }[];
      }>(ctx, `/api/judges/by-slug${qs({ slug })}`, 600);
      const j = d?.judge;
      if (!j) return { source: SOURCE, found: false, slug, disclaimer: LEGAL_DISCLAIMER };
      const areas = Object.entries(j.case_analytics?.practice_areas ?? {})
        .map(([area, v]) => ({ area, cases: v.case_count ?? 0, recent_cases: v.recent_case_count ?? 0, avg_days: v.avg_case_duration_days ?? null }))
        .sort((a, b) => b.cases - a.cases)
        .slice(0, 8);
      return {
        source: SOURCE,
        found: true,
        id: j.id ?? null,
        name: j.name,
        slug: j.slug,
        court: j.court_name ?? null,
        court_id: j.court_id ?? null,
        jurisdiction: j.jurisdiction ?? null,
        appointed: j.appointed_date ?? null,
        total_cases: j.total_cases ?? null,
        cases_analyzed: j.case_analytics?.summary?.total_cases_analyzed ?? null,
        most_recent_case: j.case_analytics?.summary?.most_recent_case_date ?? null,
        avg_case_duration_days: j.case_analytics?.summary?.average_case_duration_days ?? null,
        practice_areas: areas,
        verified: j.is_verified ?? false,
        data_source: j.data_source ?? null,
        profile_url: `${jfBase(ctx)}/judges/${j.slug}`,
        disclaimer: LEGAL_DISCLAIMER,
      };
    },
  }),

  defineTool({
    group: "legal",
    name: "legal_judge_recent_cases",
    title: "Judge's recent cases",
    description: "Recent public cases for a judge, by the numeric judge id returned from legal_search_judges.",
    input: {
      judge_id: z.string().trim().regex(/^[A-Za-z0-9-]{1,40}$/).describe("Judge id from legal_search_judges."),
      limit: z.number().int().min(1).max(25).default(10),
    },
    async run({ judge_id, limit }, ctx) {
      const d = await jf<{
        cases?: { case_number?: string; case_name?: string; case_type?: string; filing_date?: string; decision_date?: string; status?: string; outcome?: string | null }[];
      }>(ctx, `/api/judges/${encodeURIComponent(judge_id)}/recent-cases${qs({ limit })}`, 300);
      const cases = (d?.cases ?? []).slice(0, limit).map((c) => ({
        case_number: c.case_number ?? null,
        name: clip(c.case_name, 200) || null,
        type: c.case_type ?? null,
        filed: c.filing_date ?? null,
        decided: c.decision_date ?? null,
        status: c.status ?? null,
        outcome: c.outcome ?? null,
      }));
      return { source: SOURCE, judge_id, count: cases.length, cases, disclaimer: LEGAL_DISCLAIMER };
    },
  }),

  defineTool({
    group: "legal",
    name: "legal_search_courts",
    title: "Search courts",
    description:
      "Find courts by name, type (federal, state), state or county. Returns court id, location, contact details and judge count. Use the id with legal_court_judges.",
    input: {
      query: z.string().trim().max(120).optional().describe("Court name text, e.g. 'northern district'."),
      state: z.string().trim().length(2).optional().describe("Two-letter state code."),
      county: z.string().trim().max(80).optional().describe("County name (requires state)."),
      type: z.enum(["federal", "state", "local"]).optional(),
      limit: z.number().int().min(1).max(25).default(10),
    },
    async run({ query, state, county, type, limit }, ctx) {
      if (!query && !state && !type) throw new ToolInputError("Provide at least one of query, state or type.");
      if (county && !state) throw new ToolInputError("`county` needs `state` too (county names repeat across states).");
      const d = await jf<{ courts?: Court[]; total_count?: number; has_more?: boolean }>(
        ctx,
        `/api/courts${qs({ q: query, state: state?.toUpperCase(), county, type, limit })}`,
        600,
      );
      const courts = (d?.courts ?? []).slice(0, limit).map(shapeCourt);
      return { source: SOURCE, total_matches: d?.total_count ?? courts.length, has_more: d?.has_more ?? false, courts, disclaimer: LEGAL_DISCLAIMER };
    },
  }),

  defineTool({
    group: "legal",
    name: "legal_court_judges",
    title: "Judges of a court",
    description: "List judges assigned to a court, by court id from legal_search_courts.",
    input: {
      court_id: z.string().trim().regex(/^[A-Za-z0-9-]{1,40}$/),
      limit: z.number().int().min(1).max(50).default(20),
    },
    async run({ court_id, limit }, ctx) {
      const d = await jf<{ judges?: { id?: string; name: string; slug?: string; total_cases?: number }[]; total_count?: number; court_info?: { id: string; name: string; jurisdiction?: string } }>(
        ctx,
        `/api/courts/${encodeURIComponent(court_id)}/judges${qs({ limit })}`,
        600,
      );
      if (!d) return { source: SOURCE, found: false, court_id, disclaimer: LEGAL_DISCLAIMER };
      const judges = (d.judges ?? []).slice(0, limit).map((j) => ({
        id: j.id ?? null,
        name: j.name,
        slug: j.slug ?? null,
        total_cases: j.total_cases ?? null,
      }));
      return { source: SOURCE, found: true, court: d.court_info ?? { id: court_id }, total_judges: d.total_count ?? judges.length, judges, disclaimer: LEGAL_DISCLAIMER };
    },
  }),
];
