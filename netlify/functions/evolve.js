// netlify/functions/evolve.js
const { createClient } = require("@supabase/supabase-js");

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function requireSecret(event) {
  const required = process.env.GENEALOGY_SECRET;
  if (!required) return { ok: true }; // se não configurou ainda, não bloqueia (você pode ligar depois)
  const got =
    event.headers["x-genealogy-secret"] ||
    event.headers["X-Genealogy-Secret"] ||
    event.headers["x-genealogy-secret".toLowerCase()];
  if (!got || got !== required) return { ok: false, error: "Unauthorized" };
  return { ok: true };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method Not Allowed" });

    const auth = requireSecret(event);
    if (!auth.ok) return json(401, { ok: false, error: auth.error });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "Missing env vars" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Parametros do MVP (ajuste depois)
    const MIN_SAMPLES = 5;          // amostra mínima para decidir
    const PROMOTE_TOP_N = 1;        // criar 1 filha por rodada
    const FAIL_DEACTIVATE_RATE = 0.2; // se success_rate < 0.2 e >= MIN_SAMPLES -> desativa
    const MUTATION_DELTA = 0.15;    // quanto aumenta o peso base da filha

    // 1) Puxa rules ativas
    const { data: rules, error: rulesErr } = await supabase
      .from("rules")
      .select("id, lineage_id, parent_rule_id, rule_type, rule_payload, weight, active, created_at")
      .eq("active", true);

    if (rulesErr) return json(500, { ok: false, error: "Rules fetch failed", details: rulesErr.message });
    if (!rules?.length) return json(200, { ok: true, message: "No active rules to evolve", created: 0, deactivated: 0 });

    // 2) Puxa estatísticas por rule via SQL (feedback + decisions)
    //    (fazemos em 2 queries simples pra manter robusto)
    const ruleIds = rules.map((r) => r.id);

    const { data: decisions, error: decErr } = await supabase
      .from("decisions")
      .select("id, rule_id")
      .in("rule_id", ruleIds);

    if (decErr) return json(500, { ok: false, error: "Decisions fetch failed", details: decErr.message });

    const decisionIds = decisions.map((d) => d.id);
    let feedback = [];
    if (decisionIds.length) {
      const { data: fb, error: fbErr } = await supabase
        .from("feedback")
        .select("decision_id, outcome")
        .in("decision_id", decisionIds);
      if (fbErr) return json(500, { ok: false, error: "Feedback fetch failed", details: fbErr.message });
      feedback = fb || [];
    }

    // Map decision_id -> rule_id
    const decToRule = new Map(decisions.map((d) => [d.id, d.rule_id]));

    // Agg por rule
    const stats = new Map(); // rule_id -> {samples, success, fail}
    for (const r of rules) stats.set(r.id, { samples: 0, success: 0, fail: 0 });

    for (const fb of feedback) {
      const ruleId = decToRule.get(fb.decision_id);
      if (!ruleId || !stats.has(ruleId)) continue;
      const s = stats.get(ruleId);
      s.samples += 1;
      if (fb.outcome === "success") s.success += 1;
      if (fb.outcome === "fail") s.fail += 1;
    }

    // lista rankeada
    const ranked = rules.map((r) => {
      const s = stats.get(r.id) || { samples: 0, success: 0, fail: 0 };
      const success_rate = s.samples ? s.success / s.samples : null;
      return { ...r, samples: s.samples, success: s.success, fail: s.fail, success_rate };
    });

    // 3) Desativar ruins (apenas com amostra mínima)
    const toDeactivate = ranked
      .filter((r) => r.samples >= MIN_SAMPLES && (r.success_rate ?? 1) < FAIL_DEACTIVATE_RATE)
      .map((r) => r.id);

    let deactivated = 0;
    if (toDeactivate.length) {
      const { error: deactErr } = await supabase
        .from("rules")
        .update({ active: false })
        .in("id", toDeactivate);
      if (deactErr) return json(500, { ok: false, error: "Deactivate failed", details: deactErr.message });
      deactivated = toDeactivate.length;
    }

    // 4) Promover melhores: top N com amostra mínima (senão, nada)
    const promotable = ranked
      .filter((r) => r.samples >= MIN_SAMPLES)
      .sort((a, b) => (b.success_rate ?? -1) - (a.success_rate ?? -1))
      .slice(0, PROMOTE_TOP_N);

    const createdRules = [];

    for (const parent of promotable) {
      // Mutação leve: clona payload e marca genealogia
      const newPayload = {
        ...(parent.rule_payload || {}),
        evolved_from: parent.id,
        mutation: {
          at: new Date().toISOString(),
          note: "clone+tag (MVP)",
        },
      };

      const newWeight = Math.min(50, Number(parent.weight ?? 1.0) + MUTATION_DELTA);

      // Mantém mesma linhagem e tipo no MVP (mais seguro)
      const { data: inserted, error: insErr } = await supabase
        .from("rules")
        .insert([{
          lineage_id: parent.lineage_id,
          parent_rule_id: parent.id,
          rule_type: parent.rule_type,
          rule_payload: newPayload,
          weight: newWeight,
          active: true,
        }])
        .select("id, parent_rule_id, rule_type, weight, created_at")
        .single();

      if (insErr) return json(500, { ok: false, error: "Create child failed", details: insErr.message });
      createdRules.push(inserted);
    }

    return json(200, {
      ok: true,
      summary: {
        active_rules_before: rules.length,
        deactivated,
        created: createdRules.length,
      },
      created_rules: createdRules,
      deactivated_rule_ids: toDeactivate,
    });
  } catch (e) {
    return json(500, { ok: false, error: "Unhandled error", details: String(e) });
  }
};
              
