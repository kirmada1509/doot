import { z } from "zod";

export const DootConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  AUTH_MODE: z.enum(["demo", "oidc"]).default("demo"),
  DATA_STORE: z.enum(["memory", "postgres"]).default("memory"),
  SEED_DEMO_DATA: z.enum(["true", "false"]).transform((value) => value === "true").default("true"),
  DATABASE_URL: z.string().url().default("postgres://doot:doot@localhost:5432/doot"),
  CALL_E_API_KEY: z.string().min(1).default("demo-call-e-key"),
  CALL_E_DEMO_TARGET_E164: z.string().default(""),
  CALL_E_BASE_URL: z.string().url().default("https://api.heycall-e.com"),
  CALL_E_PROVIDER_GOAL_ID: z.string().min(1).default("demo-provider-goal"),
  CALL_E_CALLBACK_GOAL_ID: z.string().min(1).default("demo-callback-goal"),
  CALL_E_RELEASE_GOAL_ID: z.string().min(1).default("demo-release-goal"),
  CALL_E_CONFIRMATION_GOAL_ID: z.string().min(1).default("demo-confirmation-goal"),
  CALL_E_WEBHOOK_SECRET: z.string().default(""),
  COMMUNICATION_MODE: z.enum(["mock", "live"]).default("mock"),
  CALLER_CONTACT_MODE: z.enum(["disabled", "live"]).default("disabled"),
  VOICE_PROVIDER_MODE: z.enum(["fixture", "live"]).default("fixture"),
  COMMUNICATION_POLL_MS: z.coerce.number().int().positive().default(250),
  COMMUNICATION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  PROVIDER_PHONE_MAP_JSON: z.string().default("{}"),
  CALLER_PHONE_MAP_JSON: z.string().default("{}"),
  EXOTEL_API_KEY: z.string().min(1).default("demo-exotel-key"),
  EXOTEL_ACCOUNT_SID: z.string().min(1).default("demo-exotel-sid"),
  EXOTEL_API_TOKEN: z.string().min(1).default("demo-exotel-token"),
  EXOTEL_SUBDOMAIN: z.string().min(1).default("api.in.exotel.com"),
  EXOTEL_SMS_FROM: z.string().min(1).default("DOOTAI"),
  DEEPGRAM_API_KEY: z.string().min(1).default("demo-deepgram-key"),
  ELEVENLABS_API_KEY: z.string().min(1).default("demo-elevenlabs-key"),
  STRANDS_MODEL_PROFILE: z.string().min(1).default("bedrock-claude-sonnet"),
  PRIVACY_MODE: z.enum(["local", "vault-minio"]).default("local"),
  VAULT_ADDR: z.string().url().default("http://localhost:8200"),
  VAULT_TOKEN: z.string().min(1).default("doot-root"),
  TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
  TEMPORAL_ENABLED: z.enum(["true", "false"]).transform((value) => value === "true").default("false"),
  CONTROL_API_URL: z.string().url().default("http://localhost:4000"),
  VOICE_RUNTIME_WS_URL: z.string().min(1).default("ws://localhost:4100"),
  VOICE_RUNTIME_PUBLIC_WS_URL: z.string().min(1).default("ws://localhost:4100"),
  VOICE_RUNTIME_HTTP_URL: z.string().url().default("http://localhost:4100"),
  DEMO_DIAL_CODE: z.string().regex(/^\d{4,8}$/).default("4040"),
  INTERNAL_SERVICE_TOKEN: z.string().min(16).default("doot-local-service-token"),
  S3_ENDPOINT: z.string().url().default("http://localhost:9000"),
  S3_REGION: z.string().min(1).default("ap-south-1"),
  S3_AUDIT_BUCKET: z.string().min(1).default("doot-audit"),
  S3_ACCESS_KEY_ID: z.string().min(1).default("doot"),
  S3_SECRET_ACCESS_KEY: z.string().min(1).default("doot-minio-password"),
  OIDC_ISSUER: z.string().url().default("http://localhost:8080/realms/doot"),
  OIDC_JWKS_URL: z.string().url().default("http://localhost:8080/realms/doot/protocol/openid-connect/certs"),
  OIDC_CLIENT_ID: z.string().min(1).default("doot-console"),
  CONSOLE_ORIGIN: z.string().url().default("http://localhost:3000"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default("http://localhost:4318")
});

export type DootConfig = z.infer<typeof DootConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DootConfig {
  const config = DootConfigSchema.parse(env);
  if (config.NODE_ENV === "production" && config.AUTH_MODE !== "oidc") {
    throw new Error("Production requires AUTH_MODE=oidc");
  }
  return config;
}
