/** EMS group: read-only lookups against Protocol Guide's public site API (tRPC over HTTPS, no auth). */
import { z } from "zod";
import { clip, fetchJson, UpstreamError } from "../lib/http.js";
import { defineTool, ToolInputError, type ToolContext } from "./types.js";

export const EMS_DISCLAIMER =
  "Education and reference only. Not medical direction and not clinical decision support. Protocol text may be incomplete or out of date; verify against the cited source document and your agency's current protocols and online medical direction. Never enter patient-identifying information.";

const SOURCE = "Protocol Guide (https://protocol-guide.com)";

function pgBase(ctx: ToolContext): string {
  return (ctx.env.get("PROTOCOL_GUIDE_BASE_URL") ?? "https://protocol-guide.com").replace(/\/$/, "");
}

interface TrpcOk<T> {
  result?: { data?: { json?: T } };
}

async function trpc<T>(ctx: ToolContext, proc: string, input: unknown, ttl = 300): Promise<T> {
  const url = `${pgBase(ctx)}/api/trpc/${proc}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  let body: TrpcOk<T> | null;
  try {
    body = await fetchJson<TrpcOk<T>>(url, { service: "Protocol Guide", ttlSeconds: ttl, fetchImpl: ctx.fetchImpl });
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 400) {
      throw new ToolInputError("Protocol Guide rejected the request. Check the state code or ids and try again.");
    }
    throw err;
  }
  const data = body?.result?.data?.json;
  if (data === undefined) throw new UpstreamError("Protocol Guide", 502, "unexpected response shape");
  return data;
}

const stateSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .describe("US state as a two-letter code (CA) or full name (California). DC is accepted.");

interface SearchHit {
  id: number | string;
  protocolNumber?: string | null;
  protocolTitle?: string | null;
  section?: string | null;
  content?: string | null;
  sourcePdfUrl?: string | null;
  relevanceScore?: number | null;
  countyId?: number | null;
  agencyName?: string | null;
  stateCode?: string | null;
  protocolYear?: number | null;
  lastVerifiedAt?: string | null;
}

export const emsTools = [
  defineTool({
    group: "ems",
    name: "ems_search_protocols",
    title: "Search EMS protocols",
    description:
      "Semantic search over published EMS protocol books (local, state or national-model sets) from Protocol Guide. Scope by US state or by an agency id from ems_list_agencies. Returns cited excerpts with protocol number, agency, year and a source PDF link. Reference only, not medical direction.",
    input: {
      query: z.string().trim().min(2).max(500).describe("Plain-language question, e.g. 'adult cardiac arrest epinephrine' or 'pediatric seizure'."),
      state: stateSchema.optional(),
      agency_id: z.number().int().positive().optional().describe("Agency id from ems_list_agencies (narrows to one agency's book)."),
      limit: z.number().int().min(1).max(10).default(5),
    },
    async run({ query, state, agency_id, limit }, ctx) {
      if (!state && !agency_id) throw new ToolInputError("Provide `state` or `agency_id` so the search is scoped to a jurisdiction.");
      const data = await trpc<{ results?: SearchHit[]; totalFound?: number }>(
        ctx,
        "search.semantic",
        { query, limit, ...(agency_id ? { countyId: agency_id } : {}), ...(state ? { stateFilter: state } : {}) },
        600,
      );
      const results = (data.results ?? []).slice(0, limit).map((r) => ({
        id: Number(r.id),
        protocol_number: r.protocolNumber ?? null,
        title: r.protocolTitle ?? null,
        section: r.section ?? null,
        agency: r.agencyName ?? null,
        state: r.stateCode ?? null,
        protocol_year: r.protocolYear ?? null,
        last_verified: r.lastVerifiedAt ?? null,
        relevance: r.relevanceScore != null ? Math.round(Number(r.relevanceScore) * 10) / 10 : null,
        excerpt: clip(r.content, 1200),
        source_pdf: r.sourcePdfUrl ?? null,
      }));
      return { source: SOURCE, query, result_count: results.length, results, disclaimer: EMS_DISCLAIMER };
    },
  }),

  defineTool({
    group: "ems",
    name: "ems_get_protocol",
    title: "Get one protocol section",
    description:
      "Fetch the full text of one protocol section by the numeric id returned from ems_search_protocols, with agency, year and the source PDF link.",
    input: { id: z.number().int().positive().describe("Protocol section id from ems_search_protocols.") },
    async run({ id }, ctx) {
      const p = await trpc<{
        id: number;
        agencyId?: number;
        protocolNumber?: string;
        protocolTitle?: string;
        section?: string;
        content?: string;
        sourcePdfUrl?: string;
        protocolYear?: number;
        agencyName?: string;
        stateCode?: string;
        stateName?: string;
        lastVerifiedAt?: string;
      }>(ctx, "search.getProtocol", { id }, 3600);
      return {
        source: SOURCE,
        id: p.id,
        agency_id: p.agencyId ?? null,
        agency: p.agencyName ?? null,
        state: p.stateName ?? p.stateCode ?? null,
        protocol_number: p.protocolNumber ?? null,
        title: p.protocolTitle ?? null,
        section: p.section ?? null,
        protocol_year: p.protocolYear ?? null,
        last_verified: p.lastVerifiedAt ?? null,
        text: clip(p.content, 12_000),
        source_pdf: p.sourcePdfUrl ?? null,
        disclaimer: EMS_DISCLAIMER,
      };
    },
  }),

  defineTool({
    group: "ems",
    name: "ems_list_agencies",
    title: "List EMS agencies in a state",
    description:
      "List EMS agencies that have a protocol book loaded for a US state, with their ids and protocol section counts. Use the id as agency_id in ems_search_protocols.",
    input: { state: z.string().trim().length(2).describe("Two-letter state code, e.g. CA.") },
    async run({ state }, ctx) {
      const d = await trpc<{ agencies?: { id: number; name: string; protocolCount?: number }[] }>(
        ctx,
        "agencies.listByState",
        { stateCode: state.toUpperCase() },
        1800,
      );
      const agencies = (d.agencies ?? []).map((a) => ({ id: a.id, name: a.name, protocol_sections: a.protocolCount ?? 0 }));
      return { source: SOURCE, state: state.toUpperCase(), count: agencies.length, agencies };
    },
  }),

  defineTool({
    group: "ems",
    name: "ems_coverage",
    title: "EMS protocol coverage",
    description:
      "Coverage by state: counties covered and whether each county resolves to a local book, the state's published set, or the NASEMSO national model guidelines. Optionally filter to one state.",
    input: { state: stateSchema.optional() },
    async run({ state }, ctx) {
      const rows = await trpc<
        {
          state: string;
          stateCode: string;
          countiesTotal: number;
          countiesLive: number;
          agenciesLive: number;
          chunks: number;
          local: number;
          statewide: number;
          national: number;
        }[]
      >(ctx, "counties.coverage", undefined, 3600);
      const want = state?.trim().toLowerCase();
      const filtered = want ? rows.filter((r) => r.stateCode.toLowerCase() === want || r.state.toLowerCase() === want) : rows;
      if (want && filtered.length === 0) throw new ToolInputError(`No coverage row for "${state}".`);
      return {
        source: SOURCE,
        note: "local = county uses a local/regional book; statewide = state-published set; national = NASEMSO national model guidelines (not local protocols).",
        states: filtered.map((r) => ({
          state: r.state,
          code: r.stateCode,
          counties: r.countiesTotal,
          agencies: r.agenciesLive,
          protocol_sections: r.chunks,
          county_source_local: r.local,
          county_source_state: r.statewide,
          county_source_national: r.national,
        })),
        disclaimer: EMS_DISCLAIMER,
      };
    },
  }),
];
