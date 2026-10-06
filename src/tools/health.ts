/** Health group: public US government data only (NPI Registry, openFDA). Not medical advice. */
import { z } from "zod";
import { clip, fetchJson, qs } from "../lib/http.js";
import { defineTool, ToolInputError, type ToolContext } from "./types.js";

export const HEALTH_DISCLAIMER =
  "Not medical advice. Public data from US government sources (CMS NPPES, FDA openFDA), unvalidated and possibly incomplete. Do not use it to make decisions about diagnosis or treatment; ask a licensed clinician or pharmacist.";

const NPI_BASE = "https://npiregistry.cms.hhs.gov/api/";
const FDA_BASE = "https://api.fda.gov";

/** Luhn check for NPIs, which are validated with the 80840 prefix. */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi}`.split("").map(Number).reverse();
  let sum = 0;
  for (const [i, d] of digits.entries()) {
    if (i % 2 === 1) {
      const dbl = d * 2;
      sum += dbl > 9 ? dbl - 9 : dbl;
    } else {
      sum += d;
    }
  }
  return sum % 10 === 0;
}

function fdaUrl(ctx: ToolContext, endpoint: string, params: Record<string, string | number | undefined>): string {
  const key = ctx.env.get("OPENFDA_API_KEY");
  return `${FDA_BASE}${endpoint}${qs({ ...params, api_key: key })}`;
}

/** Quote a user-supplied term for an openFDA search expression. */
export function fdaTerm(s: string): string {
  return `"${s.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim()}"`;
}

interface FdaList<T> {
  meta?: { results?: { total?: number } };
  results?: T[];
}

async function fda<T>(ctx: ToolContext, url: string, ttl = 900): Promise<FdaList<T>> {
  const d = await fetchJson<FdaList<T>>(url, { service: "openFDA", ttlSeconds: ttl, nullOn: [404], fetchImpl: ctx.fetchImpl });
  return d ?? { results: [] };
}

const first = <T>(v: T[] | undefined): T | undefined => (v && v.length ? v[0] : undefined);

interface NpiResult {
  number: string;
  enumeration_type?: string;
  basic?: { first_name?: string; last_name?: string; middle_name?: string; credential?: string; name?: string; organization_name?: string; status?: string; sole_proprietor?: string; enumeration_date?: string; last_updated?: string; authorized_official_first_name?: string; authorized_official_last_name?: string };
  addresses?: { address_purpose?: string; address_1?: string; address_2?: string; city?: string; state?: string; postal_code?: string; telephone_number?: string }[];
  taxonomies?: { code?: string; desc?: string; primary?: boolean; state?: string; license?: string }[];
}

function shapeNpi(r: NpiResult) {
  const b = r.basic ?? {};
  const loc = r.addresses?.find((a) => a.address_purpose === "LOCATION") ?? first(r.addresses);
  const tax = r.taxonomies?.find((t) => t.primary) ?? first(r.taxonomies);
  const name = r.enumeration_type === "NPI-2" ? (b.organization_name ?? b.name ?? null) : [b.first_name, b.middle_name, b.last_name].filter(Boolean).join(" ") || null;
  return {
    npi: r.number,
    kind: r.enumeration_type === "NPI-2" ? "organization" : "individual",
    name,
    credential: b.credential ?? null,
    status: b.status === "A" ? "active" : (b.status ?? null),
    primary_taxonomy: tax?.desc ?? null,
    taxonomy_code: tax?.code ?? null,
    license: tax?.license ? `${tax.state ?? ""} ${tax.license}`.trim() : null,
    practice_location: loc
      ? { address: [loc.address_1, loc.address_2].filter(Boolean).join(", "), city: loc.city ?? null, state: loc.state ?? null, postal_code: loc.postal_code?.replace(/^(\d{5})(\d{4})$/, "$1-$2") ?? null, phone: loc.telephone_number ?? null }
      : null,
    enumerated: b.enumeration_date ?? null,
    last_updated: b.last_updated ?? null,
    registry_url: `https://npiregistry.cms.hhs.gov/provider-view/${r.number}`,
  };
}

interface LabelResult {
  set_id?: string;
  effective_time?: string;
  openfda?: { brand_name?: string[]; generic_name?: string[]; manufacturer_name?: string[]; route?: string[]; product_type?: string[]; substance_name?: string[] };
  [section: string]: unknown;
}

const LABEL_SECTIONS = [
  "boxed_warning",
  "indications_and_usage",
  "dosage_and_administration",
  "contraindications",
  "warnings_and_cautions",
  "warnings",
  "adverse_reactions",
  "drug_interactions",
  "use_in_specific_populations",
  "pregnancy",
  "overdosage",
] as const;

export const healthTools = [
  defineTool({
    group: "health",
    name: "health_npi_lookup",
    title: "NPI registry lookup",
    description:
      "Look up US healthcare providers and organizations in the CMS NPI Registry by NPI number, or search by provider name or organization name with optional state, city or specialty text. Returns identity, status, primary specialty, license and practice location.",
    input: {
      npi: z.string().trim().regex(/^\d{10}$/, "NPI is 10 digits").optional(),
      first_name: z.string().trim().max(60).optional(),
      last_name: z.string().trim().max(60).optional(),
      organization_name: z.string().trim().max(120).optional(),
      state: z.string().trim().length(2).optional(),
      city: z.string().trim().max(60).optional(),
      specialty: z.string().trim().max(80).optional().describe("Taxonomy description text, e.g. 'Emergency Medicine'."),
      limit: z.number().int().min(1).max(20).default(5),
    },
    async run(a, ctx) {
      if (a.npi && !isValidNpi(a.npi)) throw new ToolInputError("That NPI fails the check-digit test; it cannot be a real NPI.");
      const hasName = a.last_name || a.first_name || a.organization_name;
      if (!a.npi && !hasName && !(a.state && a.specialty)) {
        throw new ToolInputError("Provide an npi, a name (first/last or organization), or state plus specialty.");
      }
      const url = `${NPI_BASE}${qs({
        version: "2.1",
        number: a.npi,
        first_name: a.first_name,
        last_name: a.last_name,
        organization_name: a.organization_name,
        state: a.state?.toUpperCase(),
        city: a.city,
        taxonomy_description: a.specialty,
        limit: a.limit,
        use_first_name_alias: a.first_name ? "true" : undefined,
      })}`;
      const d = await fetchJson<{ result_count?: number; results?: NpiResult[]; Errors?: { description?: string }[] }>(url, {
        service: "NPI Registry",
        ttlSeconds: 900,
        fetchImpl: ctx.fetchImpl,
      });
      if (d?.Errors?.length) throw new ToolInputError(`NPI Registry: ${d.Errors.map((e) => e.description).join("; ")}`);
      const results = (d?.results ?? []).slice(0, a.limit).map(shapeNpi);
      return { source: "CMS NPPES NPI Registry", result_count: d?.result_count ?? results.length, results, disclaimer: HEALTH_DISCLAIMER };
    },
  }),

  defineTool({
    group: "health",
    name: "health_drug_label",
    title: "FDA drug label sections",
    description:
      "Official FDA-approved labeling text for a drug (generic or brand name) from openFDA: boxed warning, indications, dosage, contraindications, warnings, adverse reactions, interactions. Choose sections to keep output short.",
    input: {
      name: z.string().trim().min(2).max(100).describe("Generic or brand name, e.g. 'metformin' or 'Lipitor'."),
      sections: z
        .array(z.enum(LABEL_SECTIONS))
        .max(8)
        .default(["boxed_warning", "indications_and_usage", "contraindications", "warnings_and_cautions"]),
      limit: z.number().int().min(1).max(3).default(1).describe("Number of distinct labels to return."),
    },
    async run({ name, sections, limit }, ctx) {
      const term = fdaTerm(name);
      const d = await fda<LabelResult>(
        ctx,
        fdaUrl(ctx, "/drug/label.json", {
          search: `(openfda.generic_name:${term} openfda.brand_name:${term}) AND openfda.product_type:"HUMAN PRESCRIPTION DRUG"`,
          limit: Math.min(20, limit * 8),
        }),
        3600,
      );
      const wanted = name.trim().toLowerCase();
      const isExact = (r: LabelResult) => [...(r.openfda?.generic_name ?? []), ...(r.openfda?.brand_name ?? [])].some((n) => n.toLowerCase() === wanted);
      // Prefer single-ingredient labels that match the name exactly over combination products.
      const ranked = [...(d.results ?? [])].sort((a, b) => Number(isExact(b)) - Number(isExact(a)));
      const seen = new Set<string>();
      const labels = [];
      for (const r of ranked) {
        const brand = first(r.openfda?.brand_name) ?? first(r.openfda?.generic_name) ?? "unknown";
        const key = `${brand}|${first(r.openfda?.manufacturer_name) ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const text: Record<string, string> = {};
        for (const s of sections) {
          const v = r[s];
          if (Array.isArray(v) && typeof v[0] === "string") text[s] = clip(v.join("\n"), 1800);
        }
        labels.push({
          brand_name: r.openfda?.brand_name ?? [],
          generic_name: r.openfda?.generic_name ?? [],
          manufacturer: first(r.openfda?.manufacturer_name) ?? null,
          route: r.openfda?.route ?? [],
          effective_date: r.effective_time ?? null,
          dailymed_url: r.set_id ? `https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=${r.set_id}` : null,
          sections: text,
        });
        if (labels.length >= limit) break;
      }
      return { source: "FDA openFDA drug labeling", query: name, total_matching_labels: d.meta?.results?.total ?? labels.length, labels, disclaimer: HEALTH_DISCLAIMER };
    },
  }),

  defineTool({
    group: "health",
    name: "health_drug_recalls",
    title: "FDA drug recalls",
    description:
      "Search FDA drug recall enforcement reports by product or ingredient text. Returns recall number, class (I most serious), status, reason, recalling firm and report date, newest first.",
    input: {
      query: z.string().trim().min(2).max(100).describe("Product or ingredient text, e.g. 'metformin' or 'eye drops'."),
      classification: z.enum(["Class I", "Class II", "Class III"]).optional(),
      status: z.enum(["Ongoing", "Completed", "Terminated"]).optional(),
      limit: z.number().int().min(1).max(20).default(8),
    },
    async run({ query, classification, status, limit }, ctx) {
      const parts = [`product_description:${fdaTerm(query)}`];
      if (classification) parts.push(`classification:${fdaTerm(classification)}`);
      if (status) parts.push(`status:${fdaTerm(status)}`);
      const d = await fda<{
        recall_number?: string;
        classification?: string;
        status?: string;
        reason_for_recall?: string;
        product_description?: string;
        recalling_firm?: string;
        report_date?: string;
        voluntary_mandated?: string;
        distribution_pattern?: string;
        state?: string;
      }>(ctx, fdaUrl(ctx, "/drug/enforcement.json", { search: parts.join(" AND "), sort: "report_date:desc", limit }), 900);
      const recalls = (d.results ?? []).map((r) => ({
        recall_number: r.recall_number ?? null,
        classification: r.classification ?? null,
        status: r.status ?? null,
        reason: clip(r.reason_for_recall, 500),
        product: clip(r.product_description, 300),
        firm: r.recalling_firm ?? null,
        reported: r.report_date ? `${r.report_date.slice(0, 4)}-${r.report_date.slice(4, 6)}-${r.report_date.slice(6, 8)}` : null,
        initiated_by: r.voluntary_mandated ?? null,
        distribution: clip(r.distribution_pattern, 200),
      }));
      return { source: "FDA openFDA drug enforcement reports", total_matches: d.meta?.results?.total ?? recalls.length, recalls, disclaimer: HEALTH_DISCLAIMER };
    },
  }),

  defineTool({
    group: "health",
    name: "health_drug_adverse_events",
    title: "FDA adverse event reports",
    description:
      "Most frequently reported adverse reactions for a drug in FDA's FAERS database via openFDA. Counts are spontaneous reports, not incidence or proof a drug caused the event.",
    input: {
      drug: z.string().trim().min(2).max(100).describe("Generic drug name, e.g. 'ibuprofen'."),
      top: z.number().int().min(3).max(25).default(10),
    },
    async run({ drug, top }, ctx) {
      const d = await fda<{ term: string; count: number }>(
        ctx,
        fdaUrl(ctx, "/drug/event.json", {
          search: `patient.drug.openfda.generic_name:${fdaTerm(drug)}`,
          count: "patient.reaction.reactionmeddrapt.exact",
          limit: top,
        }),
        3600,
      );
      return {
        source: "FDA openFDA FAERS",
        drug,
        reactions: (d.results ?? []).map((r) => ({ reaction: r.term, reports: r.count })),
        caveat: "Spontaneous, unverified reports. Counts reflect reporting volume, not risk. Many reports list several drugs.",
        disclaimer: HEALTH_DISCLAIMER,
      };
    },
  }),
];
