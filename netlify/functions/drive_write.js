// netlify/functions/drive_write.js
// POST /.netlify/functions/drive_write
//
// Body (JSON) exemplos:
// {
//   "folder_id": "PASTA_DO_DRIVE_OPCIONAL (se não passar, usa DRIVE_FOLDER_ID ou root)",
//   "path": "logs/decision_log.json",
//   "data": { "event_id": 123, "decision": "allow" },
//   "mode": "merge" // "overwrite" | "append" | "merge"
// }
//
// Headers:
// X-API-Token: <seu token>

import { google } from "googleapis";

const json = (statusCode, obj, extraHeaders = {}) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Token",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    ...extraHeaders,
  },
  body: JSON.stringify(obj),
});

const getEnv = (name, fallback = "") => (process.env[name] || fallback).trim();

function maskEmail(email) {
  if (!email) return "";
  const [u, d] = email.split("@");
  if (!d) return "****";
  return `${u.slice(0, 2)}***@${d}`;
}

function normalizePrivateKey(pkRaw) {
  // Netlify costuma salvar como texto com "\n" literal
  // Precisamos transformar em quebras reais de linha.
  if (!pkRaw) return "";
  let pk = pkRaw;

  // se vier com aspas externas, remove
  if ((pk.startsWith('"') && pk.endsWith('"')) || (pk.startsWith("'") && pk.endsWith("'"))) {
    pk = pk.slice(1, -1);
  }

  // troca \n literal por newline real
  pk = pk.replace(/\\n/g, "\n");

  return pk;
}

async function getDriveClient() {
  const projectId = getEnv("GOOGLE_PROJECT_ID");
  const clientEmail = getEnv("GOOGLE_CLIENT_EMAIL");
  const privateKey = normalizePrivateKey(getEnv("GOOGLE_PRIVATE_KEY"));

  if (!projectId || !clientEmail || !privateKey) {
    return { ok: false, error: "missing_env" };
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  const drive = google.drive({ version: "v3", auth });

  return {
    ok: true,
    drive,
    authInfo: {
      projectId,
      clientEmailMasked: maskEmail(clientEmail),
      privateKeyLooksOk: privateKey.includes("BEGIN PRIVATE KEY") && privateKey.includes("END PRIVATE KEY"),
      privateKeyLen: privateKey.length,
    },
  };
}

async function findFileInFolderByName(drive, folderId, fileName) {
  const q = [
    `'${folderId}' in parents`,
    `name='${fileName.replace(/'/g, "\\'")}'`,
    "trashed=false",
  ].join(" and ");

  const res = await drive.files.list({
    q,
    fields: "files(id,name,mimeType,modifiedTime)",
    pageSize: 1,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });

  return (res.data.files && res.data.files[0]) || null;
}

async function ensureSubfolders(drive, rootFolderId, parts) {
  // Cria/acha subpastas dentro de rootFolderId seguindo "a/b/c"
  let parentId = rootFolderId;

  for (const part of parts) {
    if (!part) continue;

    const q = [
      `'${parentId}' in parents`,
      `name='${part.replace(/'/g, "\\'")}'`,
      "mimeType='application/vnd.google-apps.folder'",
      "trashed=false",
    ].join(" and ");

    const res = await drive.files.list({
      q,
      fields: "files(id,name)",
      pageSize: 1,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    let folder = (res.data.files && res.data.files[0]) || null;

    if (!folder) {
      const created = await drive.files.create({
        requestBody: {
          name: part,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentId],
        },
        fields: "id,name",
        supportsAllDrives: true,
      });
      folder = created.data;
    }

    parentId = folder.id;
  }

  return parentId;
}

function safeJsonParse(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false, value: null };
  }
}

function mergeObjects(a, b) {
  // merge raso + objetos
  if (Array.isArray(a) || Array.isArray(b)) return b;
  if (typeof a !== "object" || a === null) return b;
  if (typeof b !== "object" || b === null) return b;

  const out = { ...a };
  for (const k of Object.keys(b)) {
    if (typeof b[k] === "object" && b[k] && typeof a[k] === "object" && a[k]) {
      out[k] = mergeObjects(a[k], b[k]);
    } else {
      out[k] = b[k];
    }
  }
  return out;
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }

  // Token (se você quiser deixar público, basta remover este bloco)
  const requiredToken = getEnv("API_TOKEN");
  const gotToken = (event.headers["x-api-token"] || event.headers["X-API-Token"] || "").trim();
  if (requiredToken && gotToken !== requiredToken) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  const parsed = safeJsonParse(event.body || "{}");
  if (!parsed.ok) {
    return json(400, { ok: false, error: "invalid_json" });
  }

  const body = parsed.value || {};
  const folderId = (body.folder_id || getEnv("DRIVE_FOLDER_ID") || "root").trim();

  // path: "logs/decision_log.json" (padrão)
  const path = (body.path || "logs/system_log.json").trim();
  const mode = (body.mode || "overwrite").trim(); // overwrite | append | merge

  // data: objeto a gravar
  const data = body.data ?? body.payload ?? body.content ?? null;
  if (data === null || data === undefined) {
    return json(400, { ok: false, error: "missing_data", hint: "Envie body.data" });
  }

  const { ok, drive, authInfo, error } = await getDriveClient();
  if (!ok) {
    return json(500, {
      ok: false,
      error: error || "drive_auth_failed",
      hint: "Confirme GOOGLE_PROJECT_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY no Netlify",
    });
  }

  // Quebra path em pastas + arquivo
  const parts = path.split("/").map((p) => p.trim()).filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) {
    return json(400, { ok: false, error: "invalid_path" });
  }

  // cria/acha subpastas e obtém folder final
  const targetFolderId = await ensureSubfolders(drive, folderId, parts);

  // tenta achar arquivo existente
  const existing = await findFileInFolderByName(drive, targetFolderId, fileName);

  const nowIso = new Date().toISOString();
  let finalContentObj;

  if (!existing) {
    // cria arquivo novo
    if (mode === "append") {
      finalContentObj = { _meta: { createdAt: nowIso }, items: [data] };
    } else if (mode === "merge") {
      finalContentObj = mergeObjects({ _meta: { createdAt: nowIso } }, data);
    } else {
      finalContentObj = data;
    }

    const contentStr = JSON.stringify(finalContentObj, null, 2);

    const created = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [targetFolderId],
        mimeType: "application/json",
      },
      media: {
        mimeType: "application/json",
        body: contentStr,
      },
      fields: "id,name,webViewLink,modifiedTime",
      supportsAllDrives: true,
    });

    return json(200, {
      ok: true,
      action: "created",
      folder_id: targetFolderId,
      file: created.data,
      auth: authInfo,
      mode,
      path,
    });
  }

  // existe: lê conteúdo atual (para append/merge)
  let currentObj = null;
  if (mode === "append" || mode === "merge") {
    const dl = await drive.files.get(
      { fileId: existing.id, alt: "media", supportsAllDrives: true },
      { responseType: "text" }
    );
    const parsedCurrent = safeJsonParse(dl.data || "{}");
    currentObj = parsedCurrent.ok ? parsedCurrent.value : null;
  }

  if (mode === "append") {
    const base = currentObj && typeof currentObj === "object" ? currentObj : {};
    const items = Array.isArray(base.items) ? base.items : [];
    finalContentObj = {
      ...base,
      _meta: { ...(base._meta || {}), updatedAt: nowIso },
      items: [...items, data],
    };
  } else if (mode === "merge") {
    const base = currentObj && typeof currentObj === "object" ? currentObj : {};
    finalContentObj = mergeObjects(base, data);
    finalContentObj._meta = { ...(finalContentObj._meta || {}), updatedAt: nowIso };
  } else {
    // overwrite
    finalContentObj = data;
  }

  const contentStr = JSON.stringify(finalContentObj, null, 2);

  const updated = await drive.files.update({
    fileId: existing.id,
    media: { mimeType: "application/json", body: contentStr },
    fields: "id,name,webViewLink,modifiedTime",
    supportsAllDrives: true,
  });

  return json(200, {
    ok: true,
    action: "updated",
    folder_id: targetFolderId,
    file: updated.data,
    auth: authInfo,
    mode,
    path,
  });
}
