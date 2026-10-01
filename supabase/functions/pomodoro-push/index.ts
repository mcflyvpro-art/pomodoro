// Pomodoro : envoie une notification push à la fin de chaque phase, même app fermée ou écran verrouillé.
// Appelée par la page publique (schedule / cancel / clé publique) et par pg_cron (tick, protégé par un secret).
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-tick",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MSG: Record<string, { title: string; body: string }> = {
  work: { title: "Focus terminé", body: "Place à la pause." },
  short: { title: "Pause terminée", body: "On reprend ?" },
  long: { title: "Pause terminée", body: "On reprend ?" },
  idle: { title: "Le minuteur attend", body: "On s’y remet ?" },
};
// Seuls les services push des navigateurs sont acceptés comme destination.
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };
function cleanSub(s: any): Sub | null {
  try {
    if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 1024) return null;
    const u = new URL(s.endpoint);
    if (u.protocol !== "https:" || !PUSH_HOSTS.some((r) => r.test(u.hostname))) return null;
    const { p256dh, auth } = s.keys ?? {};
    if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100) return null;
    return { endpoint: s.endpoint, keys: { p256dh, auth } };
  } catch {
    return null;
  }
}

let cfg: Record<string, string> | null = null;
async function config(retry = true): Promise<Record<string, string>> {
  if (cfg) return cfg;
  const { data, error } = await sb.from("pomodoro_config").select("key,value");
  if (error) throw error;
  const c: Record<string, string> = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  if (!c.vapid_public || !c.vapid_private) {
    if (!retry) throw new Error("VAPID keys missing");
    // Première utilisation : on crée la paire de clés (la première écriture gagne).
    const k = webpush.generateVAPIDKeys();
    await sb.from("pomodoro_config").upsert(
      [{ key: "vapid_public", value: k.publicKey }, { key: "vapid_private", value: k.privateKey }],
      { onConflict: "key", ignoreDuplicates: true },
    );
    return config(false);
  }
  webpush.setVapidDetails("https://mcflyvpro-art.github.io/pomodoro/", c.vapid_public, c.vapid_private);
  cfg = c;
  return c;
}

async function tick() {
  const { data, error } = await sb.rpc("pomodoro_claim_due");
  if (error) throw error;
  const jobs = (data ?? []) as { id: number; subscription: Sub; kind: string }[];
  let sent = 0;
  await Promise.all(jobs.map(async (j) => {
    try {
      await webpush.sendNotification(j.subscription, JSON.stringify(MSG[j.kind]), { TTL: 600, urgency: "high" });
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await sb.from("pomodoro_push_jobs").delete().eq("subscription->>endpoint", j.subscription.endpoint);
      } else console.error("push failed", e?.statusCode, e?.body ?? String(e));
    }
  }));
  if (jobs.length) await sb.from("pomodoro_push_jobs").delete().in("id", jobs.map((j) => j.id));
  await sb.from("pomodoro_push_jobs").delete().eq("claimed", true).lt("fire_at", new Date(Date.now() - 3600e3).toISOString());
  await sb.from("pomodoro_push_devices").delete().lt("updated_at", new Date(Date.now() - 30 * 86400e3).toISOString());
  return { due: jobs.length, sent };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const c = await config();
    if (req.method === "GET") return json({ publicKey: c.vapid_public });
    if (req.method !== "POST") return json({ error: "method" }, 405);
    const text = await req.text();
    if (text.length > 20000) return json({ error: "too large" }, 413);
    const b = JSON.parse(text);

    if (b.action === "tick") {
      if (!c.tick_secret || req.headers.get("x-tick") !== c.tick_secret) return json({ error: "forbidden" }, 403);
      return json(await tick());
    }

    const device = typeof b.device === "string" && /^[\w-]{8,64}$/.test(b.device) ? b.device : null;
    if (!device) return json({ error: "device" }, 400);
    // Numéro d'ordre de la demande : une demande ancienne arrivée en retard ne remplace pas une plus récente.
    // Absent (ancienne version de l'app) : la demande passe toujours.
    const seq = Number.isSafeInteger(b.seq) && b.seq > 0 ? b.seq : null;

    if (b.action === "cancel") {
      const { error } = await sb.rpc("pomodoro_schedule", { p_device: device, p_seq: seq, p_sub: null, p_jobs: null });
      if (error) throw error;
      return json({ ok: true });
    }
    if (b.action === "schedule") {
      const sub = cleanSub(b.subscription);
      if (!sub) return json({ error: "subscription" }, 400);
      const now = Date.now();
      const jobs = (Array.isArray(b.jobs) ? b.jobs : []).slice(0, 13)
        .map((j: any) => ({ t: Date.parse(j?.at), kind: j?.kind }))
        .filter((j: any) => Number.isFinite(j.t) && j.t > now - 5000 && j.t < now + 13 * 3600e3 && Object.hasOwn(MSG, j.kind))
        .map((j: any) => ({ at: new Date(j.t).toISOString(), kind: j.kind }));
      const { data, error } = await sb.rpc("pomodoro_schedule", { p_device: device, p_seq: seq, p_sub: sub, p_jobs: jobs });
      if (error) throw error;
      return json({ ok: true, scheduled: data ? jobs.length : 0 });
    }
    return json({ error: "action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "server" }, 500);
  }
});
