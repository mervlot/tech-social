import { db } from '../config/db';
import { authorSelect, postInclude, serializePost } from './serializers';
import { getHiddenUserIds } from './user.service';

// User search by username or display name (case-insensitive substring).
export async function searchUsers(query: string, viewerId?: string, limit = 20) {
  const q = query.trim();
  if (!q) return [];
  const users = await db.user.findMany({
    where: {
      OR: [
        { username: { contains: q } },
        { displayName: { contains: q } },
      ],
    },
    select: { ...authorSelect, _count: { select: { followers: true } } },
    orderBy: { followers: { _count: 'desc' } },
    take: limit,
  });

  if (!viewerId) return users.map((u) => ({ ...u, isFollowing: false }));
  const following = await db.follow.findMany({
    where: { followerId: viewerId, followingId: { in: users.map((u) => u.id) } },
    select: { followingId: true },
  });
  const set = new Set(following.map((f) => f.followingId));
  return users.map((u) => ({ ...u, isFollowing: set.has(u.id) }));
}

// Full-text-ish post search (substring match on content).
export async function searchPosts(query: string, viewerId?: string, cursor?: string, limit = 20) {
  const q = query.trim();
  if (!q) return { items: [], nextCursor: null };
  const hidden = viewerId ? await getHiddenUserIds(viewerId) : [];

  const where: any = {
    content: { contains: q },
    repostOfId: null,
    ...(hidden.length ? { authorId: { notIn: hidden } } : {}),
  };

  const items = await db.post.findMany({
    where,
    include: postInclude(viewerId),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return { items: page.map(serializePost), nextCursor: hasMore ? page[page.length - 1].id : null };
}

// Posts carrying a given hashtag (normalised, without '#').
export async function getHashtagPosts(tag: string, viewerId?: string, cursor?: string, limit = 20) {
  const normalised = tag.toLowerCase().replace(/^#/, '');
  const hidden = viewerId ? await getHiddenUserIds(viewerId) : [];

  const items = await db.post.findMany({
    where: {
      hashtags: { some: { hashtag: { tag: normalised } } },
      ...(hidden.length ? { authorId: { notIn: hidden } } : {}),
    },
    include: postInclude(viewerId),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return { tag: normalised, items: page.map(serializePost), nextCursor: hasMore ? page[page.length - 1].id : null };
}

// Trending hashtags: most-used tags in posts from the last 7 days.
export async function getTrends(limit = 10) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const grouped = await db.postHashtag.groupBy({
    by: ['hashtagId'],
    where: { post: { createdAt: { gte: since } } },
    _count: { hashtagId: true },
    orderBy: { _count: { hashtagId: 'desc' } },
    take: limit,
  });
  if (!grouped.length) return [];

  const hashtags = await db.hashtag.findMany({
    where: { id: { in: grouped.map((g) => g.hashtagId) } },
  });
  const byId = new Map(hashtags.map((h) => [h.id, h.tag]));
  return grouped
    .map((g) => ({ tag: byId.get(g.hashtagId) ?? '', count: g._count.hashtagId }))
    .filter((t) => t.tag);
}
