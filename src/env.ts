export interface Env {
  BILLS_BUCKET: R2Bucket;
  vence_db: D1Database;
  ALLOWED_ORIGIN: string;
  COGNITO_REGION: string;
  COGNITO_USER_POOL_ID: string;
  COGNITO_CLIENT_ID: string;
}
