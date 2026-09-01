// Standalone evaluation never loads the optional OpenClaw host. This declaration
// describes only its runner boundary; it is excluded from production builds.
declare module "openclaw/plugin-sdk/core" {
  export interface OpenClawPluginApi {
    runtime: { agent: { runEmbeddedPiAgent: (params: Record<string, unknown>) => Promise<any> } };
  }
}
