export interface Env {
  BILLS_BUCKET: R2Bucket;
  vence_db: D1Database;
  ALLOWED_ORIGIN: string;
  COGNITO_REGION: string;
  COGNITO_USER_POOL_ID: string;
  COGNITO_CLIENT_ID: string;

  // Mercado Pago. Set with `wrangler secret put <NAME>`.
  MP_ACCESS_TOKEN: string;
  MP_PUBLIC_KEY: string;
  MP_WEBHOOK_SECRET: string;

  // IAM user with cognito-idp:AdminDeleteUser on the pool. Used by DELETE /account.
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;

  // Optional. Required once "Enhanced Security for Push Notifications" is on
  // for the Expo project; Expo recommends setting it either way.
  EXPO_ACCESS_TOKEN?: string;
}
