import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function headers() {
  return {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: headers(), body: "" };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { decision_id, outcome, score } = body;

    if (!decision_id) {
      return { statusCode: 400, headers: headers(), body: JSON.stringify({ error: "decision_id_required" }) };
    }
    if (score === undefined || score === null) {
      return { statusCode: 400, headers: headers(), body: JSON.stringify({ error: "score_required" }) };
    }

    // 1) grava feedback
    const { data: fb, error: fbErr } = await supabase
      .from("genealogical_feedback")
      .insert({ decision_id, outcome: outcome || "unknown", score })
      .select("id")
      .single();

    if (fbErr) {
      return { statusCode: 500, headers: headers(), body: JSON.stringify({ error: "feedback_insert_failed", details: fbErr.message }) };
    }

    // 2) treino automático imediato (RPC)
    const { error: trainErr } = await supabase.rpc("train_step", {
      p_decision_id: decision_id,
      p_score: score,
    });

    if (trainErr) {
      return {
        statusCode: 200,
        headers: headers(),
        body: JSON.stringify({
          ok: true,
          feedback_id: fb.id,
          trained: false,
          train_error: trainErr.message,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: headers(),
      body: JSON.stringify({ ok: true, feedback_id: fb.id, trained: true }),
    };
  } catch (e) {
    return { statusCode: 500, headers: headers(), body: JSON.stringify({ error: "feedback_crashed", details: String(e?.message || e) }) };
  }
};
