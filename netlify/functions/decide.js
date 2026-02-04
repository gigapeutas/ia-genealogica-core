import { createClient } from "@supabase/supabase-js";

/**
 * IA Genealógica — decide.js (Netlify Function)
 * - Registra evento em genealogical_events
 * - Seleciona o melhor gene ativo em cognitive_dna via matching do pattern
 * - Registra decisão em genealogical_decisions COM gene_id (fundamental para auto-treino)
 * - Retorna event_id, decision_id, gene (explicável) e decision
 */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- util: safe json ----------
function safeJsonParse(str, fallback = {}) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// ---------- util: ops ----------
function opMatch(op, actual, expected) {
  switch (op) {
    case "gte":
      return typeof actual === "number" && actual >= expected;
    case "lte":
      return typeof actual === "number" && actual <= expected;
    case "eq":
      return actual === expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "exists":
      return actual !== undefined && actual !== null;
    case "contains":
      if (typeof actual === "string") return actual.includes(String(expected));
      if (Array.isArray(actual)) return actual.includes(expected);
      return false;
    default:
      return false;
  }
}

/**
 * Pattern suportado (simples e poderoso):
 * pattern = {
 *   "risk_level": { "gte": 8 },
 *   "fase": { "eq": "triage" },
 *   "tags": { "contains": "vip" }
 * }
 *
 * Observação: pattern {} bate sempre (fallback).
 */
function geneMatches(pattern, metadata) {
  if (!pattern || typeof pattern !== "object") return false;

  const keys = Object.keys(pattern);
  if (keys.length === 0) return true; // default gene

  for (const key of keys) {
    const rule = pattern[key];
    const actual = metadata?.[key];

    // rule deve ser um objeto do tipo { op: value }
    if (!rule || typeof rule !== "object") return false;

    const ops = Object.keys(rule);
    if (ops.length === 0) return false;

    // Todas as ops daquele campo precisam bater
    for (const op of ops) {
      const expected = rule[op];

      // "exists" ignora expected
      if (op === "exists") {
        if (!opMatch(op, actual, expected)) return false;
        continue;
      }

      if (!opMatch(op, actual, expected)) return false;
    }
  }

  return true;
}

// Pequeno bônus por especificidade (mais condições = mais “preciso”)
function specificityBonus(pattern) {
  if (!pattern || typeof pattern !== "object") return 0;
  let bonus = 0;
  for (const key of Object.keys(pattern)) {
    const rule = pattern[key];
    if (rule && typeof rule === "object") bonus += Math.min(2, Object.keys(rule).length);
  }
  return Math.min(6, bonus);
}

function corsHeaders() {
  return {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

export const handler = async (event) => {
  // Preflight CORS
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return {
        statusCode: 500,
        headers: corsHeaders(),
        body: JSON.stringify({
          error: "missing_env",
          details: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados no Netlify.",
        }),
      };
    }

    const body = safeJsonParse(event.body || "{}", {});
    const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};

    // 1) Registrar evento genealógico
    const { data: ev, error: evErr } = await supabase
      .from("genealogical_events")
      .insert({
        source: "api",
        type: "decision_request",
        payload: metadata,
      })
      .select("id")
      .single();

    if (evErr || !ev) {
      return {
        statusCode: 500,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "event_insert_failed", details: evErr?.message || "unknown" }),
      };
    }

    // 2) Buscar genes ativos
    const { data: genes, error: gErr } = await supabase
      .from("cognitive_dna")
      .select("id, origin, pattern, response, weight, active, created_at")
      .eq("active", true);

    if (gErr) {
      return {
        statusCode: 500,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "genes_load_failed", details: gErr.message }),
      };
    }

    // 3) Selecionar melhor gene por match + peso + bônus de especificidade
    let best = null;
    let bestScore = -Infinity;

    for (const gene of genes || []) {
      const pattern = gene.pattern || {};
      const matches = geneMatches(pattern, metadata);
      if (!matches) continue;

      const w = Number(gene.weight ?? 1);
      const score = w + specificityBonus(pattern) * 0.05; // bônus pequeno, não domina o peso
      if (score > bestScore) {
        bestScore = score;
        best = gene;
      }
    }

    const decision = best?.response || { decision: "observe", mode: "log" };

    // 4) Registrar decisão COM gene_id (CRÍTICO)
    const { data: dec, error: dErr } = await supabase
      .from("genealogical_decisions")
      .insert({
        event_id: ev.id,
        gene_id: best?.id || null,
        decision,
        confidence: Number(best?.weight ?? 1),
      })
      .select("id")
      .single();

    if (dErr || !dec) {
      return {
        statusCode: 500,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "decision_insert_failed", details: dErr?.message || "unknown" }),
      };
    }

    // 5) Retorno explicável
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        event_id: ev.id,
        decision_id: dec.id,
        gene: best
          ? {
              id: best.id,
              origin: best.origin,
              weight: best.weight,
              pattern: best.pattern,
            }
          : null,
        decision,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "decide_crashed", details: String(err?.message || err) }),
    };
  }
};
      
