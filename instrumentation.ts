export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertProductionProviders } = await import("./lib/providers/assert");
    assertProductionProviders();
  }
}
