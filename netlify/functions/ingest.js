export default async (request) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Schema mínimo evolutivo (fica dentro do payload)
  const payload = {
    type: body.type ?? "stimulus.external",
    actor: body.actor ?? "unknown",
    message: body.message ?? null,
    metadata: body.metadata ?? {},
    raw: body, // guarda o bruto para evolução futura
  };

  const source = body.source ?? "netlify.ingest";

  // Se ainda não configurou Supabase, pelo menos prova que o endpoint está vivo
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(
      JSON.stringify({
        ok: true,
        mode: "dry_run",
        note: "Endpoint vivo. Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no Netlify para gravar no banco.",
        sample_insert: { source, payload },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      prefer: "return=representation",
    },
    body: JSON.stringify({ source, payload }),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    return new Response(
      JSON.stringify({ ok: false, error: "Supabase insert failed", details: data }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  return new Response(JSON.stringify({ ok: true, inserted: data?.[0] ?? null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
                          
