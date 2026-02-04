import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function handler(event) {
  const body = JSON.parse(event.body || "{}");
  const metadata = body.metadata || {};

  // 1) registrar evento
  const { data: ev } = await supabase
    .from("genealogical_events")
    .insert({
      source: "api",
      type: "decision_request",
      payload: metadata
    })
    .select("id")
    .single();

  // 2) buscar genes ativos
  const { data: genes } = await supabase
    .from("cognitive_dna")
    .select("*")
    .eq("active", true);

  let best = null;
  let bestScore = -Infinity;

  for (const gene of genes) {
    let match = true;
    const pattern = gene.pattern || {};

    for (const key in pattern) {
      const rule = pattern[key];
      if (rule.gte !== undefined && !(metadata[key] >= rule.gte)) {
        match = false;
      }
    }

    if (match && gene.weight > bestScore) {
      bestScore = gene.weight;
      best = gene;
    }
  }

  const decision = best?.response || { decision: "observe" };

  // 3) registrar decisão
  const { data: dec } = await supabase
    .from("genealogical_decisions")
    .insert({
      event_id: ev.id,
      decision,
      confidence: best?.weight || 1
    })
    .select("id")
    .single();

  return {
    statusCode: 200,
    body: JSON.stringify({
      event_id: ev.id,
      decision_id: dec.id,
      decision
    })
  };
}
