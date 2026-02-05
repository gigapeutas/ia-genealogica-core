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

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors(), body: "Method Not Allowed" };
  if (!isAuthorized(event.headers)) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "unauthorized" }) };

  try {
    const body = event.body ? JSON.parse(event.body) : {};

    const decision_id = Number(body.decision_id);
    const outcome = String(body.outcome || "unknown"); // ex: "correct" ou "wrong"
    const score = Number(body.score);                 // ex: +1 ou -1

    if (!decision_id || Number.isNaN(score)) {
      return {
        statusCode: 400,
        headers: { ...cors(), "Content-Type": "application/json" },
        body: JSON.stringify({ error: "missing_fields", required: ["decision_id", "score"], example: { decision_id: 5, outcome: "correct", score: 1 } }),
      };
    }

    // chama a function SQL: apply_gene_feedback(decision_id, outcome, score)
    const { data, error } = await supabase.rpc("apply_gene_feedback", {
      p_decision_id: decision_id,
      p_outcome: outcome,
      p_score: score,
    });

    if (error) throw error;

    return {
      statusCode: 200,
      headers: { ...cors(), "Content-Type": "application/json" },
      body: JSON.stringify(data),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...cors(), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "feedback_failed", details: String(e?.message || e) }),
    };
  }
}
