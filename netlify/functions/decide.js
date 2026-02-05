// netlify/functions/decide.js
// POST /.netlify/functions/decide
//
// Header: X-API-Token: <API_TOKEN>
// Body (JSON) exemplo:
// {
//   "metadata": { "risk_level": 9, "source": "whatsapp", "text": "..." },
//   "context":  { "user_id": "abc", "session_id": "xyz" },
//   "event_type": "message"
// }
//
// Resposta (exemplo):
// {
//   "event_id": 12,
//   "decision_id": 12,
//   "gene": {...},
//   "response": {...},
//   "active": true,
//   "decision": {...}
// }

import { createClient } from "@supabase/supabase-js";

const json = (statusCode, obj, extraHeaders = {}) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Token",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    ...extraHeaders,
  },
  body: JSON.stringify(obj),
});

const getEnv = (k, fallback = "") => (process.env[k] || fallback).trim();

function requireToken(event) {
  const required = getEnv("API_TOKEN");
  if (!required) return { ok: true, note: "API_TOKEN not set (token check disabled)" };

  const got =
    (event.headers["x-api-token"] || event.headers["X-API-Token"] || "").trim();

  if (got !== required) return { ok: false };
  return { ok: true };
}

// -------- Pattern matching helpers (JSON rules) --------
// Pattern esperado exemplo:
// { "risk_level": { "gte": 8 }, "source": { "in": ["whatsapp","site"] } }
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function matchOneOperator(actual, op, expected) {
  switch (op) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "gt":
      return typeof actual === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && actual >= expected;
    case "lt":
      return typeof actual === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && actual <= expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "contains":
      // strings / arrays
      if (typeof actual === "string") return actual.includes(String(expected));
      if (Array.isArray(actual)) return actual.includes(expected);
      return false;
    case "exists":
      return expected ? actual !== undefined && actual !== null : actual == null;
    default:
      return false;
  }
}

function matchPattern(metadata = {}, pattern = {}) {
  if (!isObject(pattern)) return false;

  for (const key of Object.keys(pattern)) {
    const rule = pattern[key];
    const actual = metadata[key];

    if (isObject(rule)) {
      // multiple operators
      for (const op of Object.keys(rule)) {
        if (!matchOneOperator(actual, op, rule[op])) return false;
      }
    } else {
      // shorthand eq
      if (actual !== rule) return false;
    }
  }
  return true;
}

// -------- Supabase helpers --------
function getSupabase() {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { ok: false, error: "missing_supabase_env" };
  return { ok: true, sb: createClient(url, key, { auth: { persistSession: false } }) };
}

// Choose best rule: highest weight wins; tie -> earliest id
function pickBestRule(rules = []) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const sorted = [...rules].sort((a, b) => {
    const wa = Number(a.weight || 0);
    const wb = Number(b.weight || 0);
    if (wb !== wa) return wb - wa;
    return Number(a.id || 0) - Number(b.id || 0);
  });
  return sorted[0];
}

// Default/fallback gene & response (seed)
function seedDecision(metadata = {}) {
  const risk = Number(metadata?.risk_level ?? 0);
  // exemplo simples: risk>=8 -> contain, senão allow
  const contain = risk >= 8;

  return {
    gene: {
      id: 1,
      origin: "seed",
      weight: 3,
      pattern: { risk_level: { gte: 8 } },
    },
    response: contain
      ? { mode: "block", decision: "contain" }
      : { mode: "allow", decision: "pass" },
    active: true,
  };
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  // Token
  const t = requireToken(event);
  if (!t.ok) return json(401, { ok: false, error: "unauthorized" });

  // Parse body
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  const metadata = body.metadata || {};
  const context = body.context || {};
  const eventType = body.event_type || "event";

  const supa = getSupabase();
  if (!supa.ok) {
    // Sem Supabase, ainda devolve decisão seed pra não travar
    const fallback = seedDecision(metadata);
    return json(200, {
      event_id: null,
      decision_id: null,
      ...fallback,
      decision: fallback.response,
      note: "Supabase env missing; returned seed decision only.",
    });
  }
  const sb = supa.sb;

  // 1) Carrega regras (genes) no Supabase
  // Tabelas esperadas:
  // - "gene_registry" (id, active, weight, pattern(jsonb), response(jsonb), origin)
  // - "genealogical_events" (id, event_type, metadata(jsonb), context(jsonb))
  // - "genealogical_decisions" (id, event_id, gene_id, decision(jsonb), metadata(jsonb))
  //
  // Se o seu schema usa outros nomes, me diga que eu ajusto em 30s.

  // pega genes ativos
  let genes = [];
  try {
    const { data, error } = await sb
      .from("gene_registry")
      .select("id, origin, weight, pattern, response, active")
      .eq("active", true);

    if (error) throw error;
    genes = data || [];
  } catch (e) {
    // fallback seed se a tabela não existir/der erro
    const fallback = seedDecision(metadata);
    return json(200, {
      event_id: null,
      decision_id: null,
      ...fallback,
      decision: fallback.response,
      note: "Failed to read gene_registry; returned seed decision.",
      details: String(e?.message || e),
    });
  }

  // 2) Filtra genes que batem com metadata
  const matching = genes.filter((g) => matchPattern(metadata, g.pattern || {}));
  const best = pickBestRule(matching);

  // 3) Se nada bate, usa seed
  const chosen = best
    ? {
        gene: {
          id: best.id,
          origin: best.origin || "registry",
          weight: Number(best.weight || 0),
          pattern: best.pattern || {},
        },
        response: best.response || { mode: "allow", decision: "pass" },
        active: true,
      }
    : seedDecision(metadata);

  // 4) Registra event
  let eventId = null;
  try {
    const { data, error } = await sb
      .from("genealogical_events")
      .insert([
        {
          event_type: eventType,
          metadata,
          context,
        },
      ])
      .select("id")
      .single();

    if (error) throw error;
    eventId = data?.id ?? null;
  } catch {
    // se não conseguir logar evento, segue mesmo assim
    eventId = null;
  }

  // 5) Registra decision
  let decisionId = null;
  try {
    const { data, error } = await sb
      .from("genealogical_decisions")
      .insert([
        {
          event_id: eventId,
          gene_id: chosen.gene?.id ?? null,
          decision: chosen.response,
          metadata,
        },
      ])
      .select("id")
      .single();

    if (error) throw error;
    decisionId = data?.id ?? null;
  } catch {
    decisionId = null;
  }

  return json(200, {
    event_id: eventId,
    decision_id: decisionId,
    gene: chosen.gene,
    response: chosen.response,
    active: chosen.active,
    decision: chosen.response, // compat
  });
          }
  
