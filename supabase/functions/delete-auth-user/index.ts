import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8"
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function removeUserFolder(
  supabaseAdmin: ReturnType<typeof createClient>,
  bucket: string,
  userId: string
): Promise<void> {
  const paths: string[] = [];
  let offset = 0;
  const pageSize = 100;

  while (true) {
    const { data, error } = await supabaseAdmin.storage
      .from(bucket)
      .list(userId, { limit: pageSize, offset, sortBy: { column: "name", order: "asc" } });

    if (error) {
      // A missing bucket or listing permission should not prevent the Auth
      // deletion. The service-role client normally has access to both buckets.
      console.warn(`[delete-auth-user] Could not list ${bucket}/${userId}:`, error.message);
      return;
    }

    const files = (data || []).filter((entry) => entry.id && entry.name);
    paths.push(...files.map((entry) => `${userId}/${entry.name}`));

    if ((data || []).length < pageSize) break;
    offset += pageSize;
  }

  for (let index = 0; index < paths.length; index += 100) {
    const chunk = paths.slice(index, index + 100);
    const { error } = await supabaseAdmin.storage.from(bucket).remove(chunk);
    if (error) console.warn(`[delete-auth-user] Could not remove files from ${bucket}:`, error.message);
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error("[delete-auth-user] Required Supabase environment variables are missing.");
    return json(500, { error: "Server configuration is incomplete." });
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json(401, { error: "Authentication required." });

  const requesterClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: userData, error: userError } = await requesterClient.auth.getUser();
  if (userError || !userData.user) return json(401, { error: "Invalid or expired session." });

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: requesterProfile, error: requesterProfileError } = await supabaseAdmin
    .from("profiles")
    .select("id, role")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (requesterProfileError) {
    console.error("[delete-auth-user] Could not verify requester role:", requesterProfileError.message);
    return json(500, { error: "Could not verify administrator access." });
  }

  if (String(requesterProfile?.role || "").toLowerCase() !== "admin") {
    return json(403, { error: "Administrator access required." });
  }

  let payload: { userId?: unknown };
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Request body must be valid JSON." });
  }

  const userId = payload.userId;
  if (!isUuid(userId)) return json(400, { error: "A valid userId is required." });
  if (userId === userData.user.id) return json(400, { error: "Administrators cannot delete their own account through this endpoint." });

  const { data: targetProfile, error: targetProfileError } = await supabaseAdmin
    .from("profiles")
    .select("id, role")
    .eq("id", userId)
    .maybeSingle();

  if (targetProfileError) {
    console.error("[delete-auth-user] Target lookup failed:", targetProfileError.message);
    return json(500, { error: "Could not verify the target account." });
  }

  if (targetProfile && String(targetProfile.role || "").toLowerCase() === "admin") {
    return json(403, { error: "This endpoint does not delete administrator accounts." });
  }

  // Preserve transactional/history data. Full account deletion is allowed
  // only when no Dagoldol records still reference this customer. This avoids
  // relying on unknown foreign-key cascade behavior in the production schema.
  const relatedRecordChecks = await Promise.all([
    supabaseAdmin.from("orders").select("id", { count: "exact", head: true }).eq("user_id", userId),
    supabaseAdmin.from("ratings").select("product_id", { count: "exact", head: true }).eq("user_id", userId),
    supabaseAdmin.from("dm_threads").select("id", { count: "exact", head: true }).or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`),
    supabaseAdmin.from("dm_messages").select("id", { count: "exact", head: true }).eq("sender_id", userId)
  ]);

  const relatedLabels = ["orders", "ratings", "chat threads", "chat messages"];
  for (let index = 0; index < relatedRecordChecks.length; index += 1) {
    const result = relatedRecordChecks[index];
    if (result.error) {
      console.error(`[delete-auth-user] Could not inspect ${relatedLabels[index]}:`, result.error.message);
      return json(500, { error: "Could not verify whether this account has retained history. Nothing was deleted." });
    }
    if ((result.count || 0) > 0) {
      return json(409, {
        error: "This customer still has order, rating, or chat history. The account was not deleted so business records remain intact."
      });
    }
  }

  // Auth user deletion can be rejected while the user still owns Storage
  // objects. Remove only the two user-owned Dagoldol folders first.
  await Promise.all([
    removeUserFolder(supabaseAdmin, "avatars", userId),
    removeUserFolder(supabaseAdmin, "payment-proofs", userId)
  ]);

  let { error: deleteAuthError } = await supabaseAdmin.auth.admin.deleteUser(userId);

  if (deleteAuthError) {
    // Some schemas reference profiles independently of auth.users. Remove the
    // target customer profile and retry once; the admin caller is preserved.
    const { error: profileDeleteError } = await supabaseAdmin.from("profiles").delete().eq("id", userId);
    if (profileDeleteError) {
      console.error("[delete-auth-user] Profile cleanup failed:", profileDeleteError.message);
      return json(500, { error: "Could not delete the account profile." });
    }

    const retry = await supabaseAdmin.auth.admin.deleteUser(userId);
    deleteAuthError = retry.error;
  }

  if (deleteAuthError) {
    console.error("[delete-auth-user] Auth deletion failed:", deleteAuthError.message);
    return json(500, { error: "Could not delete the authentication account." });
  }

  // If the profile did not cascade from auth.users, remove any remaining row.
  const { error: finalProfileError } = await supabaseAdmin.from("profiles").delete().eq("id", userId);
  if (finalProfileError) {
    console.warn("[delete-auth-user] Auth user deleted but final profile cleanup failed:", finalProfileError.message);
  }

  return json(200, { ok: true, userId });
});
