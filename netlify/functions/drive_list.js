import { google } from "googleapis";

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Token",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

function isAuthorized(event) {
  const token = process.env.API_TOKEN;
  if (!token) return true; // se não setar API_TOKEN, fica aberto
  const header = event.headers["x-api-token"] || event.headers["X-API-Token"];
  return header === token;
}

const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  // leitura
  ["https://www.googleapis.com/auth/drive.readonly"]
);

const drive = google.drive({ version: "v3", auth });

async function listAllFiles(folderId, pageToken = null, acc = []) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "nextPageToken, files(id,name,mimeType,size,modifiedTime,webViewLink)",
    pageSize: 1000,
    pageToken: pageToken || undefined,
  });

  acc.push(...(res.data.files || []));
  if (res.data.nextPageToken) {
    return listAllFiles(folderId, res.data.nextPageToken, acc);
  }
  return acc;
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors(), body: "" };
  }
  if (!isAuthorized(event)) {
    return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "unauthorized" }) };
  }

  try {
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const files = await listAllFiles(folderId);

    return {
      statusCode: 200,
      headers: { ...cors(), "Content-Type": "application/json" },
      body: JSON.stringify({ folder_id: folderId, count: files.length, files }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...cors(), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "drive_list_failed", details: String(e?.message || e) }),
    };
  }
}

