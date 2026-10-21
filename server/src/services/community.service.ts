import { db } from '../config/db';
import { ApiError } from '../utils/apiError';
import { authorSelect, postInclude, serializePost } from './serializers';
import { emitToCommunity } from '../sockets/io';

const PAGE = 20;

// Normalises a free-text name into a url-safe slug ("Web Design!" -> "web-design").
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

// Shapes a community row (optionally with the viewer's membership) for the API.
function shapeCommunity(c: any, viewerId?: string) {
  const membership = viewerId ? c.members?.find((m: any) => m.userId === viewerId) : undefined;
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    description: c.description ?? null,
    avatarUrl: c.avatarUrl ?? null,
    bannerUrl: c.bannerUrl ?? null,
    isPrivate: c.isPrivate,
    ownerId: c.ownerId,
    memberCount: c._count?.members ?? 0,
    postCount: c._count?.posts ?? 0,
    isMember: Boolean(membership),
    role: membership?.role ?? null,
    createdAt: c.createdAt,
  };
}

const listInclude = (viewerId?: string) => ({
  _count: { select: { members: true, posts: true } },
  ...(viewerId ? { members: { where: { userId: viewerId }, select: { userId: true, role: true } } } : {}),
});

export async function createCommunity(
  ownerId: string,
  input: { name: string; slug?: string; description?: string | null; isPrivate?: boolean },
) {
  const name = input.name.trim();
  if (!name) throw ApiError.badRequest('A name is required');

  const slug = slugify(input.slug || name);
  if (slug.length < 3) throw ApiError.badRequest('Slug must be at least 3 characters');

  const existing = await db.community.findUnique({ where: { slug }, select: { id: true } });
  if (existing) throw ApiError.conflict('That community handle is already taken');

  const community = await db.community.create({
    data: {
      slug,
      name,
      description: input.description?.trim() || null,
      isPrivate: Boolean(input.isPrivate),
      ownerId,
      members: { create: { userId: ownerId, role: 'OWNER' } },
    },
    include: listInclude(ownerId),
  });
  return shapeCommunity(community, ownerId);
}

export async function listCommunities(viewerId?: string, cursor?: string, limit = PAGE) {
  const items = await db.community.findMany({
    orderBy: [{ members: { _count: 'desc' } }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: listInclude(viewerId),
  });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return {
    items: page.map((c) => shapeCommunity(c, viewerId)),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

// Communities the viewer belongs to (for the sidebar / quick switcher).
export async function listMyCommunities(viewerId: string) {
  const rows = await db.communityMember.findMany({
    where: { userId: viewerId },
    orderBy: { joinedAt: 'desc' },
    include: { community: { include: listInclude(viewerId) } },
  });
  return rows.map((r) => shapeCommunity(r.community, viewerId));
}

async function findBySlugOrThrow(slug: string, viewerId?: string) {
  const community = await db.community.findUnique({
    where: { slug },
    include: listInclude(viewerId),
  });
  if (!community) throw ApiError.notFound('Community not found');
  return community;
}

export async function getCommunity(slug: string, viewerId?: string) {
  const community = await findBySlugOrThrow(slug, viewerId);
  return shapeCommunity(community, viewerId);
}

async function assertMember(communityId: string, userId: string) {
  const membership = await db.communityMember.findUnique({
    where: { communityId_userId: { communityId, userId } },
  });
  if (!membership) throw ApiError.forbidden('Join this community first');
  return membership;
}

export async function joinCommunity(userId: string, slug: string) {
  const community = await db.community.findUnique({ where: { slug }, select: { id: true } });
  if (!community) throw ApiError.notFound('Community not found');
  await db.communityMember.upsert({
    where: { communityId_userId: { communityId: community.id, userId } },
    create: { communityId: community.id, userId, role: 'MEMBER' },
    update: {},
  });
  return getCommunity(slug, userId);
}

export async function leaveCommunity(userId: string, slug: string) {
  const community = await db.community.findUnique({
    where: { slug },
    select: { id: true, ownerId: true },
  });
  if (!community) throw ApiError.notFound('Community not found');
  if (community.ownerId === userId) throw ApiError.badRequest('The owner cannot leave their community');
  await db.communityMember.deleteMany({ where: { communityId: community.id, userId } });
  return getCommunity(slug, userId);
}

export async function getCommunityFeed(slug: string, viewerId?: string, cursor?: string, limit = PAGE) {
  const community = await db.community.findUnique({
    where: { slug },
    select: { id: true, isPrivate: true },
  });
  if (!community) throw ApiError.notFound('Community not found');
  if (community.isPrivate) {
    if (!viewerId) throw ApiError.forbidden('This community is private');
    await assertMember(community.id, viewerId);
  }

  const items = await db.post.findMany({
    where: { communityId: community.id, parentId: null, repostOfId: null },
    include: postInclude(viewerId),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return { items: page.map(serializePost), nextCursor: hasMore ? page[page.length - 1].id : null };
}

export async function listMembers(slug: string, cursor?: string, limit = 30) {
  const community = await db.community.findUnique({ where: { slug }, select: { id: true } });
  if (!community) throw ApiError.notFound('Community not found');
  const rows = await db.communityMember.findMany({
    where: { communityId: community.id },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { communityId_userId: { communityId: community.id, userId: cursor } }, skip: 1 } : {}),
    include: { user: { select: authorSelect } },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map((r) => ({ ...r.user, role: r.role })),
    nextCursor: hasMore ? page[page.length - 1].userId : null,
  };
}

// ─────────────────────── Group chat ───────────────────────

export async function getCommunityMessages(slug: string, userId: string, cursor?: string, limit = 30) {
  const community = await db.community.findUnique({ where: { slug }, select: { id: true } });
  if (!community) throw ApiError.notFound('Community not found');
  await assertMember(community.id, userId);

  const items = await db.communityMessage.findMany({
    where: { communityId: community.id },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { sender: { select: authorSelect } },
  });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  // Returned newest-first; the client reverses for display.
  return { items: page, nextCursor: hasMore ? page[page.length - 1].id : null };
}

export async function sendCommunityMessage(slug: string, userId: string, content: string) {
  const community = await db.community.findUnique({ where: { slug }, select: { id: true } });
  if (!community) throw ApiError.notFound('Community not found');
  await assertMember(community.id, userId);

  const text = content.trim();
  if (!text) throw ApiError.badRequest('Message cannot be empty');

  const message = await db.communityMessage.create({
    data: { communityId: community.id, senderId: userId, content: text },
    include: { sender: { select: authorSelect } },
  });

  // Realtime fan-out to everyone currently in the community chat room.
  emitToCommunity(community.id, 'community:message', { communityId: community.id, slug, message });
  return message;
}

// Used by post.service to validate a post is being made into a joinable community.
export async function assertCanPostTo(communityId: string, userId: string) {
  await assertMember(communityId, userId);
}
