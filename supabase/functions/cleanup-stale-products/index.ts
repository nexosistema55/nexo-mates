import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { createCleanupHandler } from "./worker.mjs";

Deno.serve(createCleanupHandler({
  env: (name: string) => Deno.env.get(name),
  createClient,
}));
