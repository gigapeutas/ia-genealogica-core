import { google } from "googleapis";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ENV: ${name}`);
  return v;
}

export function getDrive() {
  const clientEmail = requireEnv("GOOGLE_CLIENT_EMAIL");
  let privateKey = requireEnv("GOOGLE_PRIVATE_KEY");

  // Netlify costuma salvar com \n literal. Precisamos transformar em quebras reais:
  privateKey = privateKey.replace(/\\n/g, "\n");

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return google.drive({ version: "v3", auth });
}

