import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // use service role no backend
);

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ ok: false, error: "Method Not Allowed" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { decision_id, outcome, score } = body;

    if (!decision_id || !outcome) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          ok: false,
          error: "Missing required fields: decision_id, outcome",
        }),
      };
    }

    // 1) Buscar a decisão para saber qual rule_id ela usou
    const { data: decision, error: decisionErr } = await supabase
      .from("decisions")
      .select("id, rule_id")
      .eq("id", decision_id)
      .single();

    if (decisionErr) throw decisionErr;

    // 2) Registrar feedback
    const { data: fb, error: fbErr } = await supabase
      .from("feedback")
      .insert([
        {
          decision_id,
          outcome,
          score: score ?? null,
        },
      ])
      .select()
      .single();

    if (fbErr) throw fbErr;

    // 3) Ajustar peso da regra (MVP)
    // success -> +0.1 / fail -> -0.1 (com piso 0.1)
    const delta = outcome === "success" ? 0.1 : outcome === "fail" ? -0.1 : 0;

    if (delta !== 0 && decision.rule_id) {
      // pegar weight atual
      const { data: rule, error: ruleErr } = await supabase
        .from("rules")
        .select("id, weight")
        .eq("id", decision.rule_id)
        .single();

      if (!ruleErr && rule) {
        const newWeight = Math.max(0.1, Number(rule.weight || 1) + delta);

        await supabase
          .from("rules")
          .update({ weight: newWeight })
          .eq("id", rule.id);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        feedback: fb,
        rule_weight_updated: delta !== 0,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: "Feedback handler failed",
        details: err?.message || String(err),
      }),
    };
  }
}
