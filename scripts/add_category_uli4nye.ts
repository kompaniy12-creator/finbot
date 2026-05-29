// One-off: add the "Уличные животные" category with a gte-small embedding
// for kNN. We can't compute the embedding from the script (gte-small only
// runs inside the Edge runtime), so this trampolines through setup-once.

const url = `https://${Deno.env.get("SUPABASE_PROJECT_REF")}.supabase.co`;
const secret = Deno.env.get("CRON_SECRET")!;
const resp = await fetch(`${url}/functions/v1/setup-once`, {
  method: "POST",
  headers: { "x-setup-secret": secret },
});
console.log("HTTP", resp.status);
console.log(await resp.text());
