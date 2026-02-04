import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const body = JSON.parse(event.body || "{}");

    if (!body.event_id) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          ok: false,
          error: "event_id is required",
        }),
      };
    }

    // Buscar regra ativa (observer)
    const { data: rule, error: ruleError } = await supabase
      .from("rules")
      .select("*")
      .eq("active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (ruleError || !rule) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          ok: false,
          error: "No active rule found",
        }),
      };
    }

    // Registrar decisão
    const decisionPayload = {
      rule_type: rule.rule_type,
      action: rule.rule_payload.action,
      description: rule.rule_payload.description,
    };

    const { data: decision, error: decisionError } = await supabase
      .from("decisions")
      .insert({
        event_id: body.event_id,
        rule_id: rule.id,
        decision_payload: decisionPayload,
        confidence: rule.weight,
      })
      .select()
      .single();

    if (decisionError) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          ok: false,
          error: "Decision insert failed",
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        decision,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: "Unexpected error",
      }),
    };
  }
}
