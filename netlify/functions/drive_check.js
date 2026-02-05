import { google } from "googleapis";

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization, X-API-Token",
    },
    body: JSON.stringify(data, null, 2),
  };
}

function maskEmail(email = "") {
  if (!email.includes("@")) return email;
  const [u, d] = email.split("@");
  return `${u.slice(0, 2)}***@${d}`;
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const token = event.headers["x-api-token"] || event.headers["X-API-Token"];
  if (!process.env.API_TOKEN || token !== process.env.API_TOKEN) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    body = {};
  }

  // aceita folder_id OU folderId
  const folderId = body.folder_id || body.folderId || null;

  const report = {
    ok: false,
    steps: [],
  };

  const step = (name, ok, details = null) => {
    report.steps.push({ name, ok, details });
  };

  // 1) ENV check
  const env = {
    GOOGLE_PROJECT_ID: !!process.env.GOOGLE_PROJECT_ID,
    GOOGLE_CLIENT_EMAIL: !!process.env.GOOGLE_CLIENT_EMAIL,
    GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY,
    API_TOKEN: !!process.env.API_TOKEN,
  };

  step("env_present", Object.values(env).every(Boolean), env);

  if (!Object.values(env).every(Boolean)) {
    report.ok = false;
    return json(500, {
      ...report,
      error: "missing_env",
      hint: "No Netlify > Site settings > Environment variables: confirme as 4 envs acima.",
    });
  }

  // 2) Private key sanity (sem vazar)
  const pkRaw = process.env.GOOGLE_PRIVATE_KEY;
  const pkLooksOk =
    pkRaw.includes("BEGIN PRIVATE KEY") &&
    pkRaw.includes("END PRIVATE KEY") &&
    pkRaw.length > 1000;

  step("private_key_format", pkLooksOk, {
    looks_ok: pkLooksOk,
    length: pkRaw.length,
    note: "Se estiver false: sua key está quebrada/sem \\n/sem BEGIN/END",
  });

  // 3) Auth + Drive client
  let drive;
  try {
    const privateKey = pkRaw.replace(/\\n/g, "\n"); // CRÍTICO no Netlify
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: privateKey,
      scopes: ["https://www.googleapis.com/auth/drive"],
    });

    drive = google.drive({ version: "v3", auth });
    step("auth_init", true, { client: maskEmail(process.env.GOOGLE_CLIENT_EMAIL) });
  } catch (e) {
    step("auth_init", false, { message: e?.message || String(e) });
    return json(500, { ...report, error: "auth_init_failed" });
  }

  // 4) List root
  try {
    const res = await drive.files.list({
      q: "'root' in parents and trashed=false",
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
      pageSize: 10,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    step("list_root", true, { count: res.data.files?.length || 0 });
  } catch (e) {
    step("list_root", false, { message: e?.message || String(e) });
    return json(500, { ...report, error: "list_root_failed" });
  }

  // 5) Check folder access + list inside
  if (folderId) {
    try {
      // valida se consegue "ver" a pasta
      const meta = await drive.files.get({
        fileId: folderId,
        fields: "id,name,mimeType,webViewLink",
        supportsAllDrives: true,
      });

      step("folder_get", true, meta.data);

      const list = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
        pageSize: 50,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      step("folder_list", true, { count: list.data.files?.length || 0 });
      report.ok = true;

      return json(200, {
        ...report,
        folder_id: folderId,
        files_preview: list.data.files || [],
      });
    } catch (e) {
      const code = e?.code || e?.response?.status;
      const msg = e?.message || e?.response?.data?.error?.message || String(e);

      step("folder_get_or_list", false, { code, message: msg });

      return json(500, {
        ...report,
        error: "folder_access_failed",
        folder_id: folderId,
        hint:
          "Se der 404 File not found: (1) pasta NÃO está compartilhada com a service account OU (2) folderId field está errado OU (3) key/ENV está inconsistindo entre deploys.",
      });
    }
  }

  report.ok = true;
  return json(200, { ...report, note: "Passe folder_id no body para testar a pasta." });
    }
        
