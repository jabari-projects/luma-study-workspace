export function getFrontendProductionConfigError() {
  if (!import.meta.env.PROD) {
    return "";
  }

  const missing: string[] = [];

  if (!import.meta.env.VITE_SUPABASE_URL?.trim()) {
    missing.push("VITE_SUPABASE_URL");
  }

  if (!import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()) {
    missing.push("VITE_SUPABASE_ANON_KEY");
  }

  if (missing.length === 0) {
    return "";
  }

  return `Missing required production frontend environment variables: ${missing.join(", ")}.`;
}
