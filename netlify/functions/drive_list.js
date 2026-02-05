import { getDrive } from "./_google_drive.js";

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization, X-API-Token",
    },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return {};
  }
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  try {
    const body = parseBody(event);

    // Aceita folder_id vindo do body OU querystring (pra não quebrar testes)
    const folderId =
      body.folder_id ||
      event.queryStringParameters?.folder_id ||
      "root";

    const drive = getDrive();

    // Lista arquivos dentro da pasta
    // Se folderId for "root", lista do Meu Drive da conta de serviço
    const q =
      folderId === "root"
        ? "trashed=false"
        : `'${folderId}' in parents and trashed=false`;

    const res = await drive.files.list({
      q,
      pageSize: 50,
      fields: "files(id,name,mimeType,modifiedTime,size,webViewLink)",
      orderBy: "modifiedTime desc",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    return json(200, {
      ok: true,
      folder_id: folderId,
      count: res.data.files?.length || 0,
      files: res.data.files || [],
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "drive_list_failed",
      details: err?.message || String(err),
      hint:
        "Confirme: GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_PROJECT_ID no Netlify + pasta compartilhada com a service account.",
    });
  }
}
