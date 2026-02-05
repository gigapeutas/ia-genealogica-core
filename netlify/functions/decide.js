import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const API_TOKEN = process.env.INTERNAL_API_TOKEN;

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Token",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };
}

function isAuthorized(headers) {
  if (!API_TOKEN) return true;
  const token = headers["x-api-token"] || headers["X-API-Token"];
  return token === API_TOKEN;
}

// Matching ultra simples (rápido e robusto):
// pattern = { risk_level: { gte: 8 }, phase: "x", ... }
function matchesPattern(metadata, pattern) {
  if (!pattern || typeof pattern !== "object") return true;

  for (const key of Object.keys(pattern)) {
    const rule = pattern[key];
    const value = metadata?.[key];

    if (rule && typeof rule === "object") {
      if (rule.gte !== undefined && !(value >= rule.gte)) return false;
      if (rule.lte !== undefined && !(value <= rule.lte)) return false;
      if (rule.eq !== undefined && !(value === rule.eq)) return false;
      if (rule.ne !== undefined && !(value !== rule.ne)) return false;
      if (rule.in !== undefined && Array.isArray(rule.in) && !rule.in.includes(value)) return false;
    } else {
      if (value !== rule) return false;
    }
  }
  return true;
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method Not Allowed" };
  if (!isAuthorized(event.headers)) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "unauthorized" }) };

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const metadata = body.metadata || {};

    // 1) Registrar evento
    const { data: ev, error: evErr } = await supabase
      .from("genealogical_events")
      .insert({
        source: "api",
        type: "decision_request",
        payload: metadata,
      })
      .select("id")
      .single();

    if (evErr) throw evErr;

    // 2) Buscar genes ativos
    const { data: genes, error: gErr } = await supabase
      .from("cognitive_dna")
      .select("id, origin, weight, pattern, response, active")
      .eq("active", true);

    if (gErr) throw gErr;

    // 3) Selecionar melhor gene
    let best = null;
    let bestScore = -Infinity;

    for (const gene of genes || []) {
      const ok = matchesPattern(metadata, gene.pattern);
      if (!ok) continue;

      // score atual = peso (simples e eficaz no início)
      const score = Number(gene.weight || 0);
      if (score > bestScore) {
        bestScore = score;
        best = gene;
      }
    }

    // fallback
    const decision = best?.response || { mode: "log", decision: "observe" };

    // 4) Registrar decisão (com gene_id!)
    const { data: dec, error: dErr } = await supabase
      .from("genealogical_decisions")
      .insert({
        event_id: ev.id,
        decision,
        confidence: best?.weight || 1,
        gene_id: best?.id || null,
      })
      .select("id")
      .single();

    if (dErr) throw dErr;

    return {
      statusCode: 200,
      headers: { ...cors(), "Content-Type": "application/json" },
      body: JSON.stringify({
        event_id: ev.id,
        decision_id: dec.id,
        gene: best || null,
        decision,
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...cors(), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "decide_failed", details: String(e?.message || e) }),
    };
  }
}
