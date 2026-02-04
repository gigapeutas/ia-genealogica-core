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
    const { data, error } = await supabase.rpc("evolve_genes");

    if (error) {
      return { statusCode: 500, headers: headers(), body: JSON.stringify({ error: "evolve_failed", details: error.message }) };
    }

    return { statusCode: 200, headers: headers(), body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 500, headers: headers(), body: JSON.stringify({ error: "evolve_crashed", details: String(e?.message || e) }) };
  }
};
