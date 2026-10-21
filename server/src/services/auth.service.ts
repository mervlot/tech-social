import crypto from 'crypto';
import { db } from '../config/db';
import { ApiError } from '../utils/apiError';
import { hashPassword, verifyPassword } from '../utils/password';
import { env } from '../config/env';
import {
  signAccessToken,
  generateRefreshToken,
  hashToken,
} from '../utils/jwt';
import { assertLoginAllowed, recordLoginFailure, recordLoginSuccess } from '../utils/loginGuard';
import { sendPasswordResetCode } from './mail.service';

function refreshExpiry(): Date {
  return new Date(Date.now() + env.jwt.refreshTtlDays * 24 * 60 * 60 * 1000);
}

const meSelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  passwordHash: true,
  googleId: true,
  emailVerified: true,
  verified: true,
  bio: true,
  link: true,
  location: true,
  gameStatus: true,
  avatarUrl: true,
  bannerUrl: true,
  createdAt: true,
};

function toAuthUser(user: any) {
  const { passwordHash, googleId, ...safe } = user;
  return {
    ...safe,
    hasPassword: Boolean(passwordHash),
    googleLinked: Boolean(googleId),
  };
}

// Optional device metadata captured for the "active sessions" screen.
export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

// Issues a short-lived access token plus a persisted, hashed refresh token.
// A `sessionId` ties together every token rotated from the same login (the
// "family"); on a fresh login one is generated, on rotation the parent's is
// reused so the whole chain can be tracked and burned together.
export async function issueTokens(userId: string, meta: SessionMeta = {}, sessionId?: string) {
  const accessToken = signAccessToken(userId);
  const refreshToken = generateRefreshToken();
  await db.refreshToken.create({
    data: {
      tokenHash: hashToken(refreshToken),
      userId,
      expiresAt: refreshExpiry(),
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
      ip: meta.ip ?? null,
      ...(sessionId ? { sessionId } : {}),
    },
  });
  return { accessToken, refreshToken };
}

interface RegisterArgs {
  email: string;
  username: string;
  displayName: string;
  password: string;
}

export async function register({ email, username, displayName, password }: RegisterArgs, meta?: SessionMeta) {
  const normalisedEmail = email.toLowerCase();
  const existing = await db.user.findFirst({
    where: { OR: [{ email: normalisedEmail }, { username }] },
    select: { email: true, username: true },
  });
  if (existing) {
    if (existing.email === normalisedEmail) throw ApiError.conflict('Email already in use');
    throw ApiError.conflict('Username already taken');
  }

  const passwordHash = await hashPassword(password);
  const user = await db.user.create({
    data: { email: normalisedEmail, username, displayName, passwordHash, emailVerified: false },
    select: meSelect,
  });
  const tokens = await issueTokens(user.id, meta);
  return { user: toAuthUser(user), ...tokens };
}

export async function login(identifier: string, password: string, meta?: SessionMeta) {
  const value = identifier.trim();
  const ip = meta?.ip ?? null;
  // Brute-force guard (per identifier + IP) on top of the IP rate limiter.
  assertLoginAllowed(value, ip);

  const user = await db.user.findFirst({
    where: { OR: [{ email: value.toLowerCase() }, { username: value }] },
  });
  if (!user || !user.passwordHash) {
    recordLoginFailure(value, ip);
    // Identical message whether the account exists or uses Google, to avoid
    // leaking which usernames/emails are registered.
    throw ApiError.unauthorized('Invalid credentials');
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    recordLoginFailure(value, ip);
    throw ApiError.unauthorized('Invalid credentials');
  }

  recordLoginSuccess(value, ip);
  const tokens = await issueTokens(user.id, meta);
  return { user: toAuthUser(user), ...tokens };
}

function assertGoogleConfigured() {
  if (!env.google.clientId || !env.google.clientSecret) {
    throw ApiError.badRequest('Google sign-in is not configured');
  }
}

export function getGoogleAuthUrl(state: string) {
  assertGoogleConfigured();
  const params = new URLSearchParams({
    client_id: env.google.clientId,
    redirect_uri: env.google.callbackUrl,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface GoogleProfile {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

async function fetchGoogleProfile(code: string): Promise<GoogleProfile> {
  assertGoogleConfigured();
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      redirect_uri: env.google.callbackUrl,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) throw ApiError.unauthorized('Google sign-in failed');
  const tokenData = (await tokenRes.json()) as { access_token?: string };
  if (!tokenData.access_token) throw ApiError.unauthorized('Google sign-in failed');

  const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!profileRes.ok) throw ApiError.unauthorized('Could not read Google profile');
  const profile = (await profileRes.json()) as GoogleProfile;
  if (!profile.sub || !profile.email || profile.email_verified === false) {
    throw ApiError.unauthorized('Google account email must be verified');
  }
  return profile;
}

function cleanUsername(value: string) {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 16);
  return cleaned.length >= 3 ? cleaned : `user${cleaned}`.slice(0, 16);
}

async function uniqueUsername(email: string) {
  const localPart = email.split('@')[0] || 'user';
  const base = cleanUsername(localPart);
  for (let i = 0; i < 50; i += 1) {
    const suffix = i === 0 ? '' : String(i + 1);
    const candidate = `${base.slice(0, 20 - suffix.length)}${suffix}`;
    const exists = await db.user.findUnique({ where: { username: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }
  return `user_${generateRefreshToken().slice(0, 8)}`;
}

export async function loginWithGoogle(code: string, meta?: SessionMeta) {
  const profile = await fetchGoogleProfile(code);
  const email = profile.email.toLowerCase();
  const displayName = (profile.name || email.split('@')[0] || 'Google user').slice(0, 50);
  const existing = await db.user.findFirst({
    where: { OR: [{ googleId: profile.sub }, { email }] },
    select: meSelect,
  });

  if (existing) {
    const user = await db.user.update({
      where: { id: existing.id },
      data: {
        googleId: existing.googleId ?? profile.sub,
        emailVerified: true,
        avatarUrl: existing.avatarUrl ?? profile.picture ?? null,
      },
      select: meSelect,
    });
    const tokens = await issueTokens(user.id, meta);
    return { user: toAuthUser(user), isNew: false, ...tokens };
  }

  const username = await uniqueUsername(email);
  const user = await db.user.create({
    data: {
      email,
      username,
      displayName,
      googleId: profile.sub,
      emailVerified: true,
      avatarUrl: profile.picture ?? null,
    },
    select: meSelect,
  });
  const tokens = await issueTokens(user.id, meta);
  return { user: toAuthUser(user), isNew: true, ...tokens };
}

// Revokes every still-live token in a session family. Used both for explicit
// "log out this device" and automatically when token reuse is detected.
async function revokeFamily(sessionId: string) {
  await db.refreshToken.updateMany({
    where: { sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// Validates a refresh token and rotates it: the presented token is marked
// revoked and a fresh token is issued within the same session family.
//
// Reuse detection (OWASP): if a token that was ALREADY rotated/revoked is
// presented again, it means the token leaked and both the attacker and the
// legitimate client hold copies — so we burn the entire family, forcing a new
// login. Rotation + reuse detection sharply limits the value of a stolen token.
export async function rotateRefresh(refreshToken: string, meta?: SessionMeta) {
  if (!refreshToken) throw ApiError.unauthorized('Missing refresh token');
  const tokenHash = hashToken(refreshToken);
  const stored = await db.refreshToken.findUnique({ where: { tokenHash } });

  if (!stored) throw ApiError.unauthorized('Invalid or expired session');

  // Replay of an already-revoked token → likely theft. Burn the family.
  if (stored.revokedAt) {
    if (stored.sessionId) await revokeFamily(stored.sessionId);
    throw ApiError.unauthorized('Session reuse detected — please sign in again');
  }

  const sessionId = stored.sessionId ?? stored.id;

  if (stored.expiresAt < new Date()) {
    await db.refreshToken.update({
      where: { tokenHash },
      data: { sessionId, revokedAt: new Date() },
    });
    throw ApiError.unauthorized('Invalid or expired session');
  }

  // Rotate: soft-revoke the presented token, issue a new one in the same family.
  await db.refreshToken.update({
    where: { tokenHash },
    data: { sessionId, revokedAt: new Date() },
  });
  return issueTokens(
    stored.userId,
    { userAgent: meta?.userAgent ?? stored.userAgent, ip: meta?.ip ?? stored.ip },
    sessionId,
  );
}

// ─────────────────────── Active sessions ───────────────────────

// Resolves the session family id for the refresh token currently in use.
async function currentSessionId(currentRefreshToken?: string): Promise<string | null> {
  if (!currentRefreshToken) return null;
  const row = await db.refreshToken.findUnique({
    where: { tokenHash: hashToken(currentRefreshToken) },
    select: { id: true, sessionId: true },
  });
  return row ? row.sessionId ?? row.id : null;
}

// Lists the user's active session families (one entry per login), flagging the
// current device. Revoked/expired tokens are excluded.
export async function listSessions(userId: string, currentRefreshToken?: string) {
  const currentSid = await currentSessionId(currentRefreshToken);
  const rows = await db.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
    select: { id: true, sessionId: true, userAgent: true, ip: true, createdAt: true, lastUsedAt: true },
  });

  // Collapse a family's rotated tokens into a single session entry.
  const seen = new Set<string>();
  const sessions: Array<{
    id: string;
    userAgent: string | null;
    ip: string | null;
    createdAt: Date;
    lastUsedAt: Date;
    current: boolean;
  }> = [];
  for (const r of rows) {
    const sessionId = r.sessionId ?? r.id;
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    sessions.push({
      id: sessionId,
      userAgent: r.userAgent,
      ip: r.ip,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      current: currentSid !== null && sessionId === currentSid,
    });
  }
  return sessions;
}

// Revokes an entire session family by its id ("log out this device").
export async function revokeSession(userId: string, sessionId: string) {
  const result = await db.refreshToken.updateMany({
    where: {
      userId,
      revokedAt: null,
      OR: [{ sessionId }, { id: sessionId, sessionId: null }],
    },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

// Revokes every session except the current family ("log out everywhere else").
export async function revokeOtherSessions(userId: string, currentRefreshToken?: string) {
  const currentSid = await currentSessionId(currentRefreshToken);
  await db.refreshToken.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(currentSid
        ? {
            OR: [
              { sessionId: { not: null }, NOT: { sessionId: currentSid } },
              { sessionId: null, NOT: { id: currentSid } },
            ],
          }
        : {}),
    },
    data: { revokedAt: new Date() },
  });
}

export async function logout(refreshToken?: string) {
  if (!refreshToken) return;
  // Soft-revoke so a later replay of this token still trips reuse detection.
  await db.refreshToken.updateMany({
    where: { tokenHash: hashToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function getMe(userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: meSelect });
  if (!user) throw ApiError.notFound('User not found');
  return toAuthUser(user);
}

function resetCodeHash(userId: string, code: string) {
  return hashToken(`${userId}:${code}`);
}

// Sends a short-lived code while returning the same response for unknown
// accounts so this endpoint cannot be used to discover registered users.
export async function requestPasswordReset(identifier: string) {
  const value = identifier.trim();
  const user = await db.user.findFirst({
    where: { OR: [{ email: value.toLowerCase() }, { username: value }] },
    select: { id: true, email: true, passwordHash: true },
  });
  // Always behave the same to avoid leaking which emails are registered.
  // Google-only accounts create a password from authenticated settings.
  if (!user?.passwordHash) return { code: null };

  const code = String(crypto.randomInt(100000, 1000000));
  await db.$transaction([
    db.passwordResetToken.deleteMany({ where: { userId: user.id } }),
    db.passwordResetToken.create({
      data: {
        tokenHash: resetCodeHash(user.id, code),
        userId: user.id,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    }),
  ]);

  // The desktop app has no mail server, so surface the code directly (as in
  // development) instead of trying to email it.
  const deliverByEmail = env.isProd && !env.isDesktop;
  if (deliverByEmail) {
    try {
      await sendPasswordResetCode(user.email, code);
    } catch (error) {
      await db.passwordResetToken.deleteMany({ where: { userId: user.id } });
      throw error;
    }
  }

  return { code: deliverByEmail ? null : code };
}

export async function resetPassword(identifier: string, code: string, newPassword: string) {
  const value = identifier.trim();
  const user = await db.user.findFirst({
    where: { OR: [{ email: value.toLowerCase() }, { username: value }] },
    select: { id: true },
  });
  if (!user) throw ApiError.badRequest('Invalid or expired reset code');

  const tokenHash = resetCodeHash(user.id, code);
  const record = await db.passwordResetToken.findUnique({ where: { tokenHash } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw ApiError.badRequest('Invalid or expired reset code');
  }

  const passwordHash = await hashPassword(newPassword);
  await db.$transaction([
    db.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    db.passwordResetToken.update({ where: { tokenHash }, data: { usedAt: new Date() } }),
    // Invalidate all existing sessions on password change.
    db.refreshToken.deleteMany({ where: { userId: record.userId } }),
  ]);
}

export async function changePassword(userId: string, currentPassword: string | undefined, newPassword: string) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.notFound('User not found');
  if (user.passwordHash) {
    if (!currentPassword) throw ApiError.badRequest('Current password is required');
    const ok = await verifyPassword(currentPassword, user.passwordHash);
    if (!ok) throw ApiError.badRequest('Current password is incorrect');
  }
  const passwordHash = await hashPassword(newPassword);
  await db.user.update({ where: { id: userId }, data: { passwordHash } });
}
