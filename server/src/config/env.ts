import dotenv from 'dotenv';

dotenv.config();

function normalizeOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

const clientUrls = (
  process.env.CLIENT_URL ??
  process.env.RENDER_EXTERNAL_URL ??
  'http://localhost:5173'
)
  .split(',')
  .map(normalizeOrigin)
  .filter(Boolean);
const apiUrl = normalizeOrigin(
  process.env.API_URL ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:4000',
);
const cloudinaryCloudName = process.env.CLOUDINARY_CLOUD_NAME ?? '';
const cloudinaryApiKey = process.env.CLOUDINARY_API_KEY ?? '';
const cloudinaryApiSecret = process.env.CLOUDINARY_API_SECRET ?? '';
const cloudinaryValues = [cloudinaryCloudName, cloudinaryApiKey, cloudinaryApiSecret];

if (cloudinaryValues.some(Boolean) && !cloudinaryValues.every(Boolean)) {
  throw new Error(
    'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET must be set together',
  );
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  // Desktop (Electron) mode: the API and the renderer share the same
  // http://localhost origin, so cookies must stay non-secure/Lax and the
  // CSP must not upgrade requests to https. Set DESKTOP=1 when launched by
  // the Electron shell (which still runs the server with NODE_ENV=production
  // so the built client is served and uploads are persisted in the database).
  isDesktop: process.env.DESKTOP === '1',
  // 0.0.0.0 is required when the app is opened from another device on the
  // same network, which is common when running the stack in Termux.
  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 4000),
  apiUrl,
  clientUrls,

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET', 'dev-access-secret'),
    refreshSecret: required('JWT_REFRESH_SECRET', 'dev-refresh-secret'),
    accessTtl: process.env.ACCESS_TOKEN_TTL ?? '15m',
    refreshTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    callbackUrl: process.env.GOOGLE_CALLBACK_URL ?? `${apiUrl}/api/auth/google/callback`,
    clientRedirectBase: clientUrls[0] ?? 'http://localhost:5173',
  },

  mail: {
    webhookUrl: process.env.MAIL_WEBHOOK_URL ?? '',
    webhookToken: process.env.MAIL_WEBHOOK_TOKEN ?? '',
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: (process.env.SMTP_SECURE ?? 'true') === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: (process.env.SMTP_PASS ?? '').replace(/\s+/g, ''),
    from: process.env.MAIL_FROM ?? process.env.SMTP_USER ?? '',
  },

  upload: {
    dir: process.env.UPLOAD_DIR ?? 'uploads',
    maxBytes: Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024,
  },

  cloudinary: {
    enabled: cloudinaryValues.every(Boolean),
    cloudName: cloudinaryCloudName,
    apiKey: cloudinaryApiKey,
    apiSecret: cloudinaryApiSecret,
    folder: process.env.CLOUDINARY_FOLDER ?? 'murmur',
  },
} as const;
