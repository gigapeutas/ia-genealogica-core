import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function handler(event) {
  try {
    const body = JSON.parse(event.body || "{}");
    const { decision_id, success } = body;

    if (!decision_id || typeof success !== "boolean") {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "decision_id e success são obrigatórios" })
      };
    }

    // Buscar decisão
    const { data: decision } = await supabase
      .from("genealogical_decisions")
      .select("gene_id")
      .eq("id", decision_id)
      .single();

    if (!decision?.gene_id) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Gene não encontrado para essa decisão" })
      };
    }

    // Buscar gene atual
    const { data: gene } = await supabase
      .from("cognitive_dna")
      .select("weight")
      .eq("id", decision.gene_id)
      .single();

    const oldWeight = gene.weight;
    const delta = success ? 1 : -1;
    const newWeight = Math.max(0, oldWeight + delta);

    // Atualizar peso do gene
    await supabase
      .from("cognitive_dna")
      .update({ weight: newWeight })
      .eq("id", decision.gene_id);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        gene_id: decision.gene_id,
        old_weight: oldWeight,
        new_weight: newWeight
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}
